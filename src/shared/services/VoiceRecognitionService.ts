import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { Capacitor } from '@capacitor/core';
import { getStorageItem, setStorageItem } from '../utils/storage';
import type { SpeechRecognitionOptions, SpeechRecognitionPermissions } from '../types/voice';
import { openAIWhisperService } from './OpenAIWhisperService';

// 语音识别服务（Capacitor 原生 + Web Speech Fallback + OpenAI Whisper）
class VoiceRecognitionService {
  private static instance: VoiceRecognitionService;
  private isListening = false;
  private partialResultsCallback: ((text: string) => void) | null = null;
  private errorCallback: ((error: any) => void) | null = null;
  private listeningStateCallback: ((state: 'started' | 'stopped') => void) | null = null;
  private provider: 'capacitor' | 'openai' = 'capacitor';
  private recordingDuration = 5000;
  private recordingTimeoutId: number | null = null;
  private recordingStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: BlobPart[] = [];
  private isWebEnvironment = false;
  private webSpeechRecognition: any | null = null; // Web Speech API 实例
  private webRecognitionStarting = false; // Web 启动中标记
  private forcedEnvironment: 'auto' | 'web' | 'native' = 'auto'; // 手动覆盖环境

  /** 手动覆盖环境: 'web' 强制使用 Web Speech, 'native' 强制使用 Capacitor 原生, 'auto' 自动判定 */
  public setEnvironmentOverride(mode: 'auto' | 'web' | 'native') {
    this.forcedEnvironment = mode;
    this.detectEnvironment(true);
  }

  /** 当前是否被强制为 Web */
  public getEnvironmentOverride() { return this.forcedEnvironment; }

  /** 重新判定环境（供外部调试） */
  public reDetectEnvironment() { this.detectEnvironment(true); }

  private constructor() {
    this.detectEnvironment(false);
    this.debugLog('[INIT] forcedEnvironment =', this.forcedEnvironment, 'isWebEnvironment =', this.isWebEnvironment);

    // 初始化 Web Speech API（仅纯浏览器环境）
  if (this.isWebEnvironment && (window.SpeechRecognition || (window as any).webkitSpeechRecognition)) {
      const SpeechRecognitionAPI = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
      this.webSpeechRecognition = new SpeechRecognitionAPI();
      this.webSpeechRecognition.continuous = true;
      this.webSpeechRecognition.interimResults = true;

      this.webSpeechRecognition.onstart = () => {
        this.webRecognitionStarting = false;
        this.isListening = true;
        this.listeningStateCallback?.('started');
      };
      this.webSpeechRecognition.onresult = (event: any) => {
        if (this.provider !== 'capacitor') return;
        const result = event.results[event.results.length - 1];
        if (this.partialResultsCallback) this.partialResultsCallback(result[0].transcript);
      };
      this.webSpeechRecognition.onend = () => {
        if (this.provider !== 'capacitor') return;
        this.webRecognitionStarting = false;
        this.isListening = false;
        this.listeningStateCallback?.('stopped');
      };
      this.webSpeechRecognition.onerror = (event: any) => {
        if (this.provider !== 'capacitor') return;
        this.webRecognitionStarting = false;
        this.isListening = false;
        this.listeningStateCallback?.('stopped');
        this.errorCallback?.(new Error(`语音识别错误: ${event.error}`));
      };
    }

    // 仅原生环境监听 partialResults
    if (!this.isWebEnvironment) {
      SpeechRecognition.addListener('partialResults', (data: { matches: string[] }) => {
        if (this.provider !== 'capacitor') return;
        if (data.matches?.length && this.partialResultsCallback) {
          this.partialResultsCallback(data.matches[0]);
        }
      });
    }

    // 异步加载持久化 provider
    this.loadProvider();
  }

  /**
   * 环境判定逻辑聚合
   */
  private detectEnvironment(relog: boolean) {
    if (this.forcedEnvironment === 'web') {
      this.isWebEnvironment = true;
    } else if (this.forcedEnvironment === 'native') {
      this.isWebEnvironment = false;
    } else {
      // auto 模式：多信号综合
      let nativeSignals = 0;
      try {
        const plat = Capacitor?.getPlatform?.();
        if (plat && plat !== 'web') nativeSignals++;
        if (Capacitor?.isNativePlatform?.()) nativeSignals++;
      } catch { /* ignore */ }
      const winCap = (globalThis as any).Capacitor;
      if (winCap?.isNativePlatform?.()) nativeSignals++;
      if (winCap?.getPlatform?.() && winCap.getPlatform() !== 'web') nativeSignals++;
      // 插件存在也是信号
      if (winCap?.plugins?.SpeechRecognition) nativeSignals++;
      // WebView 典型 UA 标记: wv; 纯浏览器可能没有 NativeBridge
      const hasNativeBridge = !!winCap?.NativeBridge;
      if (hasNativeBridge) nativeSignals++;
      // 经验：>=2 认为原生
      this.isWebEnvironment = nativeSignals < 2;
    }
    if (relog) this.debugLog('[ENV-DETECT] forced=', this.forcedEnvironment, 'isWebEnvironment=', this.isWebEnvironment);
  }

  private debugLog(...args: any[]) {
    // 可根据需要切换为条件编译 / 环境变量
    if (typeof console !== 'undefined') console.log('[VoiceRecognitionService]', ...args);
  }

  private async loadProvider() {
    try {
      const storedProvider = await getStorageItem<string>('speech_recognition_provider');
      if (storedProvider === 'openai' || storedProvider === 'capacitor') this.provider = storedProvider;
    } catch { /* ignore */ }
  }

  public static getInstance(): VoiceRecognitionService {
    if (!VoiceRecognitionService.instance) VoiceRecognitionService.instance = new VoiceRecognitionService();
    return VoiceRecognitionService.instance;
  }

  public async setProvider(provider: 'capacitor' | 'openai') {
    if (this.isListening || this.webRecognitionStarting) await this.stopRecognition();
    this.provider = provider;
    await setStorageItem('speech_recognition_provider', provider);
  }

  public getProvider(): 'capacitor' | 'openai' { return this.provider; }

  public async checkPermissions(): Promise<SpeechRecognitionPermissions> {
    if (this.provider === 'capacitor') {
      // Web环境使用Web API
      if (this.isWebEnvironment) {
        try {
          // 优先使用 Permissions API 来检查权限状态，避免触发权限请求
          if ('permissions' in navigator) {
            try {
              const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
              if (permissionStatus.state === 'granted') {
                return { speechRecognition: 'granted' };
              } else if (permissionStatus.state === 'denied') {
                return { speechRecognition: 'denied' };
              } else {
                return { speechRecognition: 'prompt' };
              }
            } catch (permError) {
              return { speechRecognition: 'unknown' };
            }
          } else {
            // 如果不支持 Permissions API，返回 unknown，让 requestPermissions 处理
            return { speechRecognition: 'unknown' };
          }
        } catch (error) {
          // 如果 Permissions API 失败，返回 unknown
          return { speechRecognition: 'unknown' };
        }
      } else {
        // 非Web环境使用Capacitor
        try {
          return await SpeechRecognition.checkPermissions();
        } catch (error) {
          return { speechRecognition: 'unknown' };
        }
      }
    } else {
      // OpenAI Whisper使用Web API，所以需要检查麦克风权限
      try {
        // 优先使用 Permissions API
        if ('permissions' in navigator) {
          const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (permissionStatus.state === 'granted') {
            return { speechRecognition: 'granted' };
          } else if (permissionStatus.state === 'denied') {
            return { speechRecognition: 'denied' };
          } else {
            return { speechRecognition: 'prompt' };
          }
        } else {
          return { speechRecognition: 'unknown' };
        }
      } catch (error) {
        return { speechRecognition: 'unknown' };
      }
    }
  }

  /** 请求语音识别权限 */
  public async requestPermissions(): Promise<SpeechRecognitionPermissions> {
    if (this.provider === 'capacitor') {
      // Web环境使用Web API
      if (this.isWebEnvironment) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop()); // 立即停止，只是为了请求权限
          return { speechRecognition: 'granted' };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            return { speechRecognition: 'denied' };
          }
          return { speechRecognition: 'denied' };
        }
      } else {
        // 非Web环境使用Capacitor
        try {
          return await SpeechRecognition.requestPermissions();
        } catch (error) {
          return { speechRecognition: 'denied' };
        }
      }
    } else {
      // OpenAI Whisper使用Web API，通过尝试访问麦克风来请求权限
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop()); // 立即停止，只是为了请求权限
        return { speechRecognition: 'granted' };
      } catch (error) {

        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          return { speechRecognition: 'denied' };
        }
        return { speechRecognition: 'denied' };
      }
    }
  }

  /** 检查语音识别是否可用 */
  public isVoiceRecognitionAvailable(): boolean {
    if (this.provider === 'capacitor') {
      if (this.isWebEnvironment) {
        // Web环境检查
        const hasWebSpeechAPI = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
        const isSecureContext = window.isSecureContext || window.location.protocol === 'https:' ||
                               window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';



        return hasWebSpeechAPI && isSecureContext && !!this.webSpeechRecognition;
      } else {
        // 移动环境，假设Capacitor可用
        return true;
      }
    } else {
      // OpenAI Whisper需要麦克风权限
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }
  }

  public async startRecognition(options?: SpeechRecognitionOptions): Promise<void> {
  this.debugLog('[startRecognition] provider=', this.provider, 'isWebEnvironment=', this.isWebEnvironment, 'listening=', this.isListening, 'starting=', this.webRecognitionStarting);
  // 运行前再次确认（防止热更新或延迟加载导致状态不一致）
  this.detectEnvironment(true);
  this.debugLog('[startRecognition] after detect: isWebEnvironment=', this.isWebEnvironment);
    // Web 分支重复启动保护（不调用 stop，直接忽略）
    if (this.provider === 'capacitor' && this.isWebEnvironment) {
      if (this.isListening || this.webRecognitionStarting) return;
    } else if (this.isListening) {
      // 原生/Whisper 若仍在监听则先停止
      await this.stopRecognition();
      await new Promise(r => setTimeout(r, 150));
    }

    if (!this.isVoiceRecognitionAvailable()) {
      const error = new Error('语音识别在当前环境下不可用');
      this.errorCallback?.(error);
      throw error;
    }

    try {
      if (this.provider === 'capacitor') {
        if (this.isWebEnvironment && this.webSpeechRecognition) {
          this.webRecognitionStarting = true;
          this.webSpeechRecognition.lang = options?.language || 'zh-CN';
          try {
            this.webSpeechRecognition.start();
          } catch (err: any) {
            this.webRecognitionStarting = false;
            if (err?.message?.includes('recognition has already started')) return; // 忽略重复
            throw err;
          }
        } else {
          this.debugLog('[startRecognition] using Capacitor native start');
          this.isListening = true;
          this.listeningStateCallback?.('started');
          await SpeechRecognition.start({
            language: options?.language || 'zh-CN',
            maxResults: options?.maxResults || 5,
            partialResults: options?.partialResults !== false,
            popup: options?.popup || false,
          });
        }
      } else {
        this.isListening = true;
        this.listeningStateCallback?.('started');
        await this.startWhisperRecognition();
      }
    } catch (error) {
      this.isListening = false;
      this.webRecognitionStarting = false;
      this.listeningStateCallback?.('stopped');
      this.errorCallback?.(error);
      throw error;
    }
  }

  /** 使用OpenAI Whisper 开始录音并转写 */
  private async startWhisperRecognition(): Promise<void> {
    try {
      // 请求麦克风权限并开始录制
      this.recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.recordingStream);
      this.audioChunks = [];

      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        this.audioChunks.push(event.data);
      });

      this.mediaRecorder.addEventListener('stop', async () => {
        try {
          // 创建音频Blob
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });

          // 停止所有轨道
          if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => track.stop());
            this.recordingStream = null;
          }

          // 加载Whisper设置
          await this.loadWhisperSettings();

          // 调用Whisper API转录
          const transcription = await openAIWhisperService.transcribeAudio(audioBlob);

          // 如果有部分结果回调，发送结果
          if (this.partialResultsCallback && transcription.text) {
            this.partialResultsCallback(transcription.text);
          }
        } catch (error) {
          if (this.errorCallback) {
            this.errorCallback(error);
          }
        } finally {
          this.isListening = false;
          if (this.listeningStateCallback) {
            this.listeningStateCallback('stopped');
          }
          this.mediaRecorder = null;
        }
      });

      // 开始录制
      this.mediaRecorder.start();

      // 设置定时器自动停止录制
      this.recordingTimeoutId = window.setTimeout(() => {
        this.stopWhisperRecording();
      }, this.recordingDuration);
    } catch (error) {
      this.isListening = false;
      if (this.listeningStateCallback) {
        this.listeningStateCallback('stopped');
      }
      if (this.errorCallback) {
        this.errorCallback(error);
      }
      throw error;
    }
  }

  /** 停止 Whisper 录音 */
  private stopWhisperRecording(): void {
    if (this.recordingTimeoutId) {
      clearTimeout(this.recordingTimeoutId);
      this.recordingTimeoutId = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  /** 加载 Whisper 相关设置 */
  private async loadWhisperSettings(): Promise<void> {
    try {
      const apiKey = await getStorageItem<string>('whisper_api_key') || '';
      const model = await getStorageItem<string>('whisper_model') || 'whisper-1';
      const language = await getStorageItem<string>('whisper_language');
      const temperature = Number(await getStorageItem<string>('whisper_temperature') || '0');
      const responseFormat = await getStorageItem<string>('whisper_response_format') || 'json';

      openAIWhisperService.setApiKey(apiKey);
      openAIWhisperService.setModel(model);
      if (language) {
        openAIWhisperService.setLanguage(language);
      }
      openAIWhisperService.setTemperature(temperature);
      openAIWhisperService.setResponseFormat(responseFormat as any);
    } catch (error) {
      // 静默处理错误
    }
  }

  /** 停止语音识别（任意模式） */
  public async stopRecognition(): Promise<void> {
  this.debugLog('[stopRecognition] isListening=', this.isListening, 'starting=', this.webRecognitionStarting, 'webEnv=', this.isWebEnvironment);
    if (!this.isListening && !this.webRecognitionStarting) {
      return;
    }

    try {
      // 先设置状态为false和通知监听器，防止重复调用
      this.isListening = false;
      this.webRecognitionStarting = false;
      if (this.listeningStateCallback) {
        this.listeningStateCallback('stopped');
      }

      if (this.provider === 'capacitor') {
        if (this.isWebEnvironment && this.webSpeechRecognition) {
          try {
            this.webSpeechRecognition.stop();
          } catch (err) {
            // 静默处理错误
          }
        } else {
          this.debugLog('[stopRecognition] using Capacitor native stop');
          await SpeechRecognition.stop().catch(() => {
            // 静默处理错误
          });
        }
      } else {
        this.stopWhisperRecording();
      }
    } catch (error) {
      // 即使出错，也确保状态被设置为stopped
      if (this.errorCallback) {
        this.errorCallback(error);
      }
      // 不再抛出错误，因为这会导致调用方需要额外的错误处理
    }
  }

  /** 设置部分结果回调 */
  public setPartialResultsCallback(callback: (text: string) => void): void {
    this.partialResultsCallback = callback;
  }

  /** 设置监听状态回调 */
  public setListeningStateCallback(callback: (state: 'started' | 'stopped') => void): void {
    this.listeningStateCallback = callback;
  }

  /** 设置错误回调 */
  public setErrorCallback(callback: (error: any) => void): void {
    this.errorCallback = callback;
  }

  /** 是否正在监听 */
  public getIsListening(): boolean {
    return this.isListening;
  }

  /** 获取支持的语言列表 */
  public async getSupportedLanguages(): Promise<string[]> {
    if (this.provider === 'capacitor') {
      // Web环境
      if (this.isWebEnvironment) {
        // 常见语言代码列表
        return [
          'zh-CN', 'en-US', 'fr-FR', 'de-DE', 'ja-JP', 'ko-KR',
          'es-ES', 'it-IT', 'pt-BR', 'ru-RU'
        ];
      } else {
        // 非Web环境
        try {
          const result = await SpeechRecognition.getSupportedLanguages();
          return result.languages || [];
        } catch (error) {
          return [];
        }
      }
    } else {
      // OpenAI Whisper支持的语言列表
      return [
        'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'nl', 'tr', 'pl', 'ar',
        'hi', 'id', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
        'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn',
        'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk',
        'sq', 'sw', 'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be',
        'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo', 'ht', 'ps', 'tk', 'nn', 'mt', 'sa',
        'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su'
      ];
    }
  }

  /** 设置 Whisper 录音时长 */
  public setRecordingDuration(durationMs: number): void {
    this.recordingDuration = durationMs;
  }
}

export const voiceRecognitionService = VoiceRecognitionService.getInstance();