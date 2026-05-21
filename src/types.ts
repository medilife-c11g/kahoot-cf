export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Zero Trust Access config
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  // Local dev bypass (leave empty in production)
  DEV_USER_EMAIL?: string;
}

export interface AuthVars {
  userId: string;
  userName: string;
  userEmail: string;
}

export interface Question {
  id: string;
  position: number;
  text: string;
  options: string[];
  correctIndex: number;
  timeLimitSec: number;
}

export interface Quiz {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export type ServerMsg =
  | { t: 'lobby'; players: { id: string; nickname: string }[]; quizTitle: string }
  | { t: 'question'; index: number; total: number; text: string; options: string[]; timeLimitSec: number; startedAt: number }
  | { t: 'answer-ack'; correct: boolean | null }
  | { t: 'results'; index: number; correctIndex: number; counts: number[]; leaderboard: { nickname: string; score: number }[] }
  | { t: 'ended'; leaderboard: { nickname: string; score: number }[] }
  | { t: 'error'; message: string }
  | { t: 'pong' };

export type ClientMsg =
  | { t: 'host-start' }
  | { t: 'host-next' }
  | { t: 'host-end' }
  | { t: 'player-answer'; choice: number }
  | { t: 'ping' };
