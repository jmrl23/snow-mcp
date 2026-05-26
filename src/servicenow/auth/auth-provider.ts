export interface AuthProvider {
  getAuthHeader(): Promise<string>;
  onUnauthorized(): Promise<void>;
}
