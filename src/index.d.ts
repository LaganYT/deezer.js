export type EntityType = "track" | "album" | "artist" | "playlist";

export interface Entity {
  type: EntityType;
  info: Record<string, any>;
  tracks: Array<Record<string, any>>;
}

export interface WorkerEnv {
  DEEZER_API_KEY?: string;
  [key: string]: unknown;
}

export declare class DeezerAPI {
  constructor(arl?: string);

  api(method: string, body: Record<string, any>): Promise<Record<string, any>>;
  search(query: string, type?: EntityType): Promise<Array<Record<string, any>>>;
  get(idOrURL: string, type?: EntityType): Promise<Entity | null>;
  getAndDecryptTrack(track: Record<string, any>, flac?: boolean): Promise<Uint8Array>;

  searchTracks(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  searchAlbums(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  searchArtists(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  searchAll(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  getAudioURL(params: Record<string, any>, env: WorkerEnv, request: Request): Promise<Response>;
  streamTrack(trackId: string, env: WorkerEnv): Promise<Response>;
  getArtist(artistId: string, env: WorkerEnv): Promise<Response>;
  getArtistAlbums(artistId: string, params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  getAlbum(albumId: string, env: WorkerEnv): Promise<Response>;
  getTopCharts(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  downloadTrack(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  getLyrics(params: Record<string, any>, env: WorkerEnv): Promise<Response>;
  downloadWithCustomMetadata(params: Record<string, any>, env: WorkerEnv, request: Request): Promise<Response>;
}

export { DeezerAPI as Deezer };
export default DeezerAPI;
