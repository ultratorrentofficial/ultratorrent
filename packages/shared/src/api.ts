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
  /** IANA zone for displaying times; null means follow the device. */
  timezone: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse extends AuthTokens {
  user: AuthUser;
}

