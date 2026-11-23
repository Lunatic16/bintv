/** Minimal ambient declarations for UMD browser libraries loaded via script tags. */

interface HlsLevel { height?: number; bitrate?: number }
interface HlsEventData { fatal?: boolean; type?: string; details?: string; level?: number }
interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
  destroy(): void;
  recoverMediaError(): void;
  startLoad(): void;
  currentLevel: number;
  levels: HlsLevel[];
  on(event: string, cb: (_e: unknown, data: HlsEventData) => void): void;
}
type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: Record<string, string>;
  ErrorTypes: Record<string, string>;
};

interface Window {
  Hls?: HlsConstructor;
}
type Hls = HlsInstance;

interface QRCodeStatic {
  toCanvas(canvas: HTMLCanvasElement, text: string, options?: Record<string, unknown>): Promise<void>;
}
declare const QRCode: QRCodeStatic;
