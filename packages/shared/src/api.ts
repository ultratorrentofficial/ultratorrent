/**
 * Shared API request/response envelope types.
 */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  roles: string[];
  permissions: string[];
  isActive: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse extends AuthTokens {
  user: AuthUser;
}

export type NotificationChannel =
  | 'in_app'
  | 'email'
  | 'webhook'
  | 'discord'
  | 'slack'
  | 'telegram';

export type SystemEventType =
  | 'torrent.added'
  | 'torrent.completed'
  | 'torrent.failed'
  | 'disk.full'
  | 'engine.offline'
  | 'automation.failed';
