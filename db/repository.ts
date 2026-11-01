import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";

import {
  getDb,
  isAtlasConnected,
  getLastConnectionError,
  withMongoTransaction,
  checkTransactionSupport,
} from './mongo.ts';

export class DatabaseDisconnectedError extends Error {
  constructor(message = 'MongoDB Atlas is currently disconnected. Please verify your Atlas IP Access List.') {
    super(message);
    this.name = 'DatabaseDisconnectedError';
  }
}

export type UserRole = 'USER' | 'VERIFIER' | 'ADMIN';

export interface UserRecord {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
  createdAt: string;
}

export interface ItemRecord {
  _id: string;
  userId: string;
  reportType: 'LOST' | 'FOUND';
  itemName: string;
  category: string;
  description: string;
  color: string;
  location: string;
  date: string;
  imageId: string | null;
  status: 'OPEN' | 'CLAIMED' | 'RECLAIMED' | 'CLOSED';
  createdAt: string;
  updatedAt: string;
}

export type MatchStatus = 'PENDING' | 'CLAIM_IN_PROGRESS' | 'VERIFIED' | 'REJECTED' | 'CLOSED' | 'RECLAIMED';

export interface ScoreBreakdown {
  name: { score: number; max: number; note: string };
  category: { score: number; max: number; note: string };
  color: { score: number; max: number; note: string };
  description: { score: number; max: number; note: string };
  location: { score: number; max: number; note: string };
  date: { score: number; max: number; note: string };
}

export interface MatchAuditEntry {
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  previousStatus: MatchStatus;
  newStatus: MatchStatus;
  timestamp: string;
  note?: string;
}

export interface MatchRecord {
  _id: string;
  lostItemId: string;
  foundItemId: string;
  ownerId: string;
  finderId: string;
  score: number;
  breakdown: ScoreBreakdown;
  status: MatchStatus;
  createdAt: string;
  updatedAt: string;
  verifiedBy?: string;
  verifiedAt?: string;
  rejectionReason?: string;
  reclaimedAt?: string;
    verificationAnswers?: {
    question: string;
    answer: string;
  }[];
  verificationSubmittedAt?: string;
  auditLog?: MatchAuditEntry[];
}

export type NotificationEventType =
  | 'MATCH_DETECTED'
  | 'CLAIM_INITIATED'
  | 'CLAIM_VERIFIED'
  | 'CLAIM_REJECTED'
  | 'ITEM_RECLAIMED';

export type NotificationDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'RETRYING';

export interface NotificationRecord {
  _id: string;
  userId: string;
  matchId: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  eventType?: NotificationEventType;
  deliveryStatus?: NotificationDeliveryStatus;
  attempts?: number;
  lastError?: string;
}

export interface NotificationOutboxRecord {
  _id: string;
  userId: string;
  matchId: string;
  title: string;
  message: string;
  eventType?: NotificationEventType;
  status: NotificationDeliveryStatus | 'PROCESSED';
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  processedAt?: string;
}

export interface NotificationInsertResult {
  success: boolean;
  inserted: boolean;
  duplicate: boolean;
  notification?: NotificationRecord;
  error?: string;
}

export function inferEventType(title: string): NotificationEventType {
  const lower = title.toLowerCase();
  if (lower.includes('reclaim')) return 'ITEM_RECLAIMED';
  if (lower.includes('reject')) return 'CLAIM_REJECTED';
  if (lower.includes('verifi')) return 'CLAIM_VERIFIED';
  if (lower.includes('claim')) return 'CLAIM_INITIATED';
  return 'MATCH_DETECTED';
}

export interface AtomicRecoveryParams {
  matchId: string;
  actor: {
    id: string;
    name: string;
    role: UserRole;
  };
  note?: string;
  forceFailStep?: 'MATCH' | 'LOST' | 'FOUND' | 'OUTBOX';
  simulatedNotificationFailure?: boolean;
}

export interface AtomicRecoveryResult {
  success: boolean;
  alreadyReclaimed?: boolean;
  match?: MatchRecord;
  error?: string;
  errorCode?:
    | 'MATCH_NOT_FOUND'
    | 'INVALID_STATE'
    | 'MISSING_LOST_ITEM'
    | 'MISSING_FOUND_ITEM'
    | 'INVALID_ITEM_RELATION'
    | 'UNAUTHORIZED'
    | 'CONCURRENT_REQUEST'
    | 'TRANSACTION_FAILED';
  outboxIds?: string[];
  transactionType?: 'MONGODB_REPLICA_TRANSACTION' | 'SNAPSHOT_ISOLATION_FALLBACK';
}

export interface ImageRecord {
  _id: string;
  filename: string;
  contentType: string;
  data: Buffer;
  ownerId: string;
}

// In-memory fallback stores (active when MongoDB Atlas is offline or IP restricted)
const memUsers = new Map<string, UserRecord>();
const memItems = new Map<string, ItemRecord>();
const memMatches = new Map<string, MatchRecord>();
const memNotifications = new Map<string, NotificationRecord>();
const memNotificationOutbox = new Map<string, NotificationOutboxRecord>();
const memImages = new Map<string, ImageRecord>();

// Concurrency lock for atomic recovery requests
const activeRecoveryLocks = new Set<string>();

export function getActiveRecoveryLocksCount(): number {
  return activeRecoveryLocks.size;
}

function createSvgBuffer(icon: string, title: string, bg: string, fg: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="${bg}" rx="16"/>
    <circle cx="300" cy="180" r="70" fill="rgba(255,255,255,0.2)"/>
    <text x="300" y="200" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="70" text-anchor="middle">${icon}</text>
    <text x="300" y="290" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="24" font-weight="600" fill="${fg}" text-anchor="middle">${title}</text>
    <text x="300" y="325" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" fill="${fg}" opacity="0.8" text-anchor="middle">ReClaim Verified Item</text>
  </svg>`;
  return Buffer.from(svg, 'utf-8');
}

// Seed the in-memory store once for testing and evaluation (strictly blocked in production)
let fallbackInitialized = false;
export function initFallbackData(force = false) {
  if (fallbackInitialized && !force) return;
  if (process.env.NODE_ENV === 'production' && !force) {
    return; // Strictly forbidden in production
  }
  fallbackInitialized = true;

  const now = new Date();
  const hashedPassword = bcrypt.hashSync('Password123', 10);

  // 1. Users with verified roles (Ordinary users and Campus Verifier)
  memUsers.set('user_demo_01', {
    _id: 'user_demo_01',
    name: 'Alex Morgan',
    email: 'demo@example.com',
    passwordHash: hashedPassword,
    role: 'USER',
    createdAt: new Date(now.getTime() - 86400000 * 10).toISOString(),
  });

  memUsers.set('user_ananya_02', {
    _id: 'user_ananya_02',
    name: 'Ananya Sharma',
    email: 'ananya@example.com',
    passwordHash: hashedPassword,
    role: 'USER',
    createdAt: new Date(now.getTime() - 86400000 * 8).toISOString(),
  });

  memUsers.set('user_rahul_03', {
    _id: 'user_rahul_03',
    name: 'Rahul Varma',
    email: 'rahul@example.com',
    passwordHash: hashedPassword,
    role: 'USER',
    createdAt: new Date(now.getTime() - 86400000 * 5).toISOString(),
  });

  // Dedicated Member 3 Campus Verifier account
  memUsers.set('user_verifier_04', {
    _id: 'user_verifier_04',
    name: 'Vikram Roy (Campus Verifier)',
    email: 'verifier@example.com',
    passwordHash: hashedPassword,
    role: 'VERIFIER',
    createdAt: new Date(now.getTime() - 86400000 * 12).toISOString(),
  });

  // 2. Images
  const imgAnanya = 'img_ananya_wallet';
  memImages.set(imgAnanya, {
    _id: imgAnanya,
    filename: 'ananya_wallet.svg',
    contentType: 'image/svg+xml',
    data: createSvgBuffer('👛', 'Black Leather Wallet', '#292524', '#fafaf9'),
    ownerId: 'user_ananya_02',
  });

  const imgRahul = 'img_rahul_wallet';
  memImages.set(imgRahul, {
    _id: imgRahul,
    filename: 'rahul_found_wallet.svg',
    contentType: 'image/svg+xml',
    data: createSvgBuffer('👛', 'Found Black Wallet', '#1c1917', '#f5f5f4'),
    ownerId: 'user_rahul_03',
  });

  // 3. Items
  const lostItemId = 'item_ananya_lost_01';
  memItems.set(lostItemId, {
    _id: lostItemId,
    userId: 'user_ananya_02',
    reportType: 'LOST',
    itemName: 'Wallet',
    category: 'Accessories',
    description: 'Black leather wallet with a small silver logo and college ID card inside.',
    color: 'Black',
    location: 'MVP Colony',
    date: new Date(now.getTime() - 86400000 * 2).toISOString(),
    imageId: imgAnanya,
    status: 'OPEN',
    createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    updatedAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
  });

  const foundItemId = 'item_rahul_found_02';
  memItems.set(foundItemId, {
    _id: foundItemId,
    userId: 'user_rahul_03',
    reportType: 'FOUND',
    itemName: 'Wallet',
    category: 'Accessories',
    description: 'Black leather wallet found near sidewalk bench with silver logo.',
    color: 'Black',
    location: 'Near MVP Colony',
    date: new Date(now.getTime() - 86400000 * 2).toISOString(),
    imageId: imgRahul,
    status: 'OPEN',
    createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    updatedAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
  });

  // 4. Initial Match (94% similarity)
  const matchId = 'match_demo_01';
  memMatches.set(matchId, {
    _id: matchId,
    lostItemId: lostItemId,
    foundItemId: foundItemId,
    ownerId: 'user_ananya_02',
    finderId: 'user_rahul_03',
    score: 94,
    breakdown: {
      name: { score: 20, max: 20, note: 'Exact name match' },
      category: { score: 15, max: 15, note: 'Identical category: Accessories' },
      color: { score: 15, max: 15, note: 'Matching colour palette: black' },
      description: { score: 14, max: 20, note: 'Matched details: black, leather, wallet, silver' },
      location: { score: 20, max: 20, note: 'Nearby area match: "mvp, colony"' },
      date: { score: 10, max: 10, note: 'Identical date of incident' },
    },
    status: 'PENDING',
    createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    updatedAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    auditLog: [
      {
        actorId: 'system_matching_engine',
        actorName: 'Member 2 Smart Matching Engine',
        actorRole: 'ADMIN',
        action: 'MATCH_DETECTED',
        previousStatus: 'PENDING',
        newStatus: 'PENDING',
        timestamp: new Date(now.getTime() - 86400000 * 2).toISOString(),
        note: 'Initial potential match identified with 94% similarity score.',
      },
    ],
  });

  // 5. Notifications
  memNotifications.set('notif_ananya_01', {
    _id: 'notif_ananya_01',
    userId: 'user_ananya_02',
    matchId: matchId,
    title: 'Possible match found!',
    message: 'A found item (Wallet) may match your lost Wallet (94% similarity).',
    isRead: false,
    createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
  });

  memNotifications.set('notif_rahul_02', {
    _id: 'notif_rahul_02',
    userId: 'user_rahul_03',
    matchId: matchId,
    title: 'Possible match found!',
    message: 'Your found item (Wallet) may match a reported lost Wallet (94% similarity).',
    isRead: false,
    createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
  });
}

// Automatically prepare fallback data on module load
initFallbackData();

function getConnectedDb(): Db | null {
  const db = getDb();
  if (db && isAtlasConnected()) {
    return db;
  }
  return null;
}

export type StoragePolicy = 'ATLAS_MANDATORY' | 'TEST_MOCK_ALLOWED';
export type ActiveStorageMode = 'ATLAS' | 'TEST_MEMORY_MOCK' | 'UNAVAILABLE';

let explicitTestStorageAllowed = false;

/**
 * Explicitly allows test in-memory storage for isolated unit tests.
 * Strictly forbidden in production environments.
 */
export function setExplicitTestStorage(allowed: boolean): void {
  if (allowed && process.env.NODE_ENV === 'production') {
    throw new Error('Security Violation: In-memory fallback cannot be enabled in production.');
  }
  explicitTestStorageAllowed = allowed;
}

export function isTestStorageAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return explicitTestStorageAllowed || process.env.NODE_ENV === 'test' || process.env.ALLOW_MEMORY_FALLBACK === 'true';
}

export function getActiveStorageMode(): ActiveStorageMode {
  if (isAtlasConnected() && getDb()) return 'ATLAS';
  if (isTestStorageAllowed()) return 'TEST_MEMORY_MOCK';
  return 'UNAVAILABLE';
}

export function isAtlasMandatory(): boolean {
  return process.env.NODE_ENV === 'production' || !isTestStorageAllowed();
}

/**
 * Ensures the persistent database is available before executing data operations.
 * Throws DatabaseDisconnectedError in production to prevent silent data loss.
 */
export function ensureDatabaseAvailable(operationName: string): Db | null {
  const db = getConnectedDb();
  if (db) return db;

  if (isTestStorageAllowed()) {
    return null; // Signals test mock path is explicitly authorized
  }

  const lastErr = getLastConnectionError() || 'MongoDB Atlas is not connected';
  throw new DatabaseDisconnectedError(
    `Database operation '${operationName}' failed: MongoDB Atlas is currently offline or unreachable (${lastErr}). In-memory fallback is disabled in this environment to prevent silent data loss.`
  );
}

export function isUsingFallback(): boolean {
  return getConnectedDb() === null && isTestStorageAllowed();
}

// ==================== USERS REPOSITORY ====================

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const db = ensureDatabaseAvailable('findUserByEmail');
  const normalized = email.trim().toLowerCase();
  if (db) {
    return await db.collection<UserRecord>('users').findOne({ email: normalized });
  }
  for (const u of memUsers.values()) {
    if (u.email.toLowerCase() === normalized) return u;
  }
  return null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const db = ensureDatabaseAvailable('findUserById');
  if (db) {
    return await db.collection<UserRecord>('users').findOne({ _id: id as any });
  }
  return memUsers.get(id) || null;
}

export async function insertUser(user: UserRecord): Promise<void> {
  const db = ensureDatabaseAvailable('insertUser');
  if (db) {
    await db.collection<UserRecord>('users').insertOne(user as any);
    return;
  }
  memUsers.set(user._id, { ...user });
}

// ==================== ITEMS REPOSITORY ====================

export async function getAllActiveItems(): Promise<ItemRecord[]> {
  const db = ensureDatabaseAvailable('getAllActiveItems');
  if (db) {
    return await db.collection<ItemRecord>('items').find({ status: 'OPEN' }).toArray();
  }
  return Array.from(memItems.values()).filter(i => i.status === 'OPEN');
}

export async function findItems(filter: { reportType?: string; status?: string }): Promise<ItemRecord[]> {
  const db = ensureDatabaseAvailable('findItems');
  if (db) {
    const query: any = {};
    if (filter.reportType) query.reportType = filter.reportType;
    if (filter.status) query.status = filter.status;
    return await db.collection<ItemRecord>('items').find(query).sort({ createdAt: -1 }).toArray();
  }
  return Array.from(memItems.values())
    .filter(i => {
      if (filter.reportType && i.reportType !== filter.reportType) return false;
      if (filter.status && i.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function findItemsByUser(userId: string): Promise<ItemRecord[]> {
  const db = ensureDatabaseAvailable('findItemsByUser');
  if (db) {
    return await db.collection<ItemRecord>('items').find({ userId }).sort({ createdAt: -1 }).toArray();
  }
  return Array.from(memItems.values())
    .filter(i => i.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function findItemById(id: string): Promise<ItemRecord | null> {
  const db = ensureDatabaseAvailable('findItemById');
  if (db) {
    return await db.collection<ItemRecord>('items').findOne({ _id: id as any });
  }
  return memItems.get(id) || null;
}

export async function insertItem(item: ItemRecord): Promise<void> {
  const db = ensureDatabaseAvailable('insertItem');
  if (db) {
    await db.collection<ItemRecord>('items').insertOne(item as any);
    return;
  }
  memItems.set(item._id, { ...item });
}

export async function updateItemStatus(id: string, status: ItemRecord['status']): Promise<ItemRecord | null> {
  const db = ensureDatabaseAvailable('updateItemStatus');
  const updatedAt = new Date().toISOString();
  if (db) {
    await db.collection<ItemRecord>('items').updateOne({ _id: id as any }, { $set: { status, updatedAt } });
    return await db.collection<ItemRecord>('items').findOne({ _id: id as any });
  }
  const item = memItems.get(id);
  if (item) {
    item.status = status;
    item.updatedAt = updatedAt;
    return { ...item };
  }
  return null;
}

// ==================== MEMBER 2: MATCHES REPOSITORY ====================

export async function findMatchesForUser(userId: string): Promise<MatchRecord[]> {
  const db = ensureDatabaseAvailable('findMatchesForUser');
  if (db) {
    return await db.collection<MatchRecord>('matches').find({
      $or: [{ ownerId: userId }, { finderId: userId }]
    }).sort({ score: -1 }).toArray();
  }
  return Array.from(memMatches.values())
    .filter(m => m.ownerId === userId || m.finderId === userId)
    .sort((a, b) => b.score - a.score);
}

export async function findMatchByItems(lostItemId: string, foundItemId: string): Promise<MatchRecord | null> {
  const db = ensureDatabaseAvailable('findMatchByItems');
  if (db) {
    return await db.collection<MatchRecord>('matches').findOne({ lostItemId, foundItemId });
  }
  for (const m of memMatches.values()) {
    if (m.lostItemId === lostItemId && m.foundItemId === foundItemId) return m;
  }
  return null;
}

export async function findMatchById(id: string): Promise<MatchRecord | null> {
  const db = ensureDatabaseAvailable('findMatchById');
  if (db) {
    return await db.collection<MatchRecord>('matches').findOne({ _id: id as any });
  }
  return memMatches.get(id) || null;
}

export async function upsertMatch(match: MatchRecord): Promise<void> {
  const db = ensureDatabaseAvailable('upsertMatch');
  const nowStr = new Date().toISOString();
  if (db) {
    await db.collection<MatchRecord>('matches').updateOne(
      { lostItemId: match.lostItemId, foundItemId: match.foundItemId },
      {
        $setOnInsert: {
          _id: match._id,
          lostItemId: match.lostItemId,
          foundItemId: match.foundItemId,
          ownerId: match.ownerId,
          finderId: match.finderId,
          status: 'PENDING' as MatchStatus,
          createdAt: match.createdAt || nowStr,
        },
        $set: {
          score: match.score,
          breakdown: match.breakdown,
          updatedAt: match.updatedAt || nowStr,
        },
      },
      { upsert: true }
    );
    return;
  }
  let foundKey: string | null = null;
  for (const [k, m] of memMatches.entries()) {
    if (m.lostItemId === match.lostItemId && m.foundItemId === match.foundItemId) {
      foundKey = k;
      break;
    }
  }
  if (foundKey) {
    const existing = memMatches.get(foundKey)!;
    memMatches.set(foundKey, {
      ...existing,
      score: match.score,
      breakdown: match.breakdown,
      updatedAt: match.updatedAt || nowStr,
    });
  } else {
    memMatches.set(match._id, {
      ...match,
      status: match.status || 'PENDING',
      createdAt: match.createdAt || nowStr,
      updatedAt: match.updatedAt || nowStr,
    });
  }
}

export async function updateMatchStatus(
  id: string,
  status: MatchStatus,
  auditEntry?: MatchAuditEntry,
  extraFields?: Partial<MatchRecord>
): Promise<MatchRecord | null> {
  const db = ensureDatabaseAvailable('updateMatchStatus');
  const updatedAt = new Date().toISOString();
  if (db) {
    const updateDoc: any = {
      $set: {
        status,
        updatedAt,
        ...(extraFields || {}),
      },
    };
    if (auditEntry) {
      updateDoc.$push = { auditLog: auditEntry };
    }
    await db.collection<MatchRecord>('matches').updateOne({ _id: id as any }, updateDoc);
    return await db.collection<MatchRecord>('matches').findOne({ _id: id as any });
  }
  const match = memMatches.get(id);
  if (match) {
    match.status = status;
    match.updatedAt = updatedAt;
    if (extraFields) {
      Object.assign(match, extraFields);
    }
    if (auditEntry) {
      if (!match.auditLog) match.auditLog = [];
      match.auditLog.push(auditEntry);
    }
    return { ...match };
  }
  return null;
}

export async function getAllMatches(): Promise<MatchRecord[]> {
  const db = ensureDatabaseAvailable('getAllMatches');
  if (db) {
    return await db.collection<MatchRecord>('matches').find().sort({ score: -1 }).toArray();
  }
  return Array.from(memMatches.values()).sort((a, b) => b.score - a.score);
}

export async function updateMatchesForItemStatus(itemId: string, status: 'CLOSED' | 'RECLAIMED'): Promise<void> {
  const targetStatus = status === 'RECLAIMED' ? 'RECLAIMED' : 'CLOSED';
  const updatedAt = new Date().toISOString();
  const db = ensureDatabaseAvailable('updateMatchesForItemStatus');
  if (db) {
    await db.collection<MatchRecord>('matches').updateMany(
      { $or: [{ lostItemId: itemId }, { foundItemId: itemId }] },
      { $set: { status: targetStatus, updatedAt } }
    );
    return;
  }
  for (const m of memMatches.values()) {
    if (m.lostItemId === itemId || m.foundItemId === itemId) {
      m.status = targetStatus;
      m.updatedAt = updatedAt;
    }
  }
}

export async function getAllMatchesCount(): Promise<number> {
  const db = ensureDatabaseAvailable('getAllMatchesCount');
  if (db) {
    return await db.collection<MatchRecord>('matches').countDocuments();
  }
  return memMatches.size;
}

// ==================== MEMBER 2: NOTIFICATIONS REPOSITORY ====================

export async function findNotificationsForUser(userId: string): Promise<NotificationRecord[]> {
  const db = ensureDatabaseAvailable('findNotificationsForUser');
  if (db) {
    return await db.collection<NotificationRecord>('notifications')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
  }
  return Array.from(memNotifications.values())
    .filter(n => n.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  const db = ensureDatabaseAvailable('getUnreadNotificationCount');
  if (db) {
    return await db.collection<NotificationRecord>('notifications').countDocuments({ userId, isRead: false });
  }
  return Array.from(memNotifications.values()).filter(n => n.userId === userId && !n.isRead).length;
}

export async function notificationExistsForMatch(userId: string, matchId: string, title?: string): Promise<boolean> {
  const db = ensureDatabaseAvailable('notificationExistsForMatch');
  if (db) {
    const query: any = { userId, matchId };
    if (title) query.title = title;
    const count = await db.collection<NotificationRecord>('notifications').countDocuments(query);
    return count > 0;
  }
  for (const n of memNotifications.values()) {
    if (n.userId === userId && n.matchId === matchId && (!title || n.title === title)) return true;
  }
  return false;
}

export async function insertNotification(
  notification: NotificationRecord,
  options?: { throwOnDatabaseError?: boolean; simulateDatabaseError?: boolean }
): Promise<NotificationInsertResult> {
  const eventType = notification.eventType || inferEventType(notification.title);
  const doc: NotificationRecord = {
    ...notification,
    eventType,
    deliveryStatus: notification.deliveryStatus || 'SENT',
    attempts: notification.attempts || 1,
  };

  const db = ensureDatabaseAvailable('insertNotification');
  if (db) {
    if (options?.simulateDatabaseError) {
      if (options.throwOnDatabaseError) {
        throw new Error('Simulated database error during notification insert');
      }
      return { success: false, inserted: false, duplicate: false, error: 'Simulated database error during notification insert' };
    }

    try {
      const res = await db.collection<NotificationRecord>('notifications').updateOne(
        { userId: notification.userId, matchId: notification.matchId, title: notification.title },
        { $setOnInsert: doc as any },
        { upsert: true }
      );

      if (res.upsertedCount > 0) {
        return { success: true, inserted: true, duplicate: false, notification: doc };
      } else {
        // Matched existing document -> safe duplicate idempotency
        return { success: true, inserted: false, duplicate: true, notification: doc };
      }
    } catch (err: any) {
      if (err.message?.includes('E11000') || err.code === 11000) {
        // Safe duplicate constraint hit
        return { success: true, inserted: false, duplicate: true, notification: doc };
      }
      // Genuine database error: do NOT silently swallow
      if (options?.throwOnDatabaseError) {
        throw err;
      }
      return { success: false, inserted: false, duplicate: false, error: err.message || 'Database insert failed' };
    }
  }

  // Explicit test mock in-memory store
  if (options?.simulateDatabaseError) {
    if (options.throwOnDatabaseError) {
      throw new Error('Simulated database error during notification insert');
    }
    return { success: false, inserted: false, duplicate: false, error: 'Simulated database error during notification insert' };
  }

  // Deduplication in memory: check by (userId, matchId) and (title OR eventType)
  for (const n of memNotifications.values()) {
    if (n.userId === notification.userId && n.matchId === notification.matchId) {
      if (n.title === notification.title || n.eventType === eventType) {
        return { success: true, inserted: false, duplicate: true, notification: { ...n } };
      }
    }
  }

  memNotifications.set(notification._id, { ...doc });
  return { success: true, inserted: true, duplicate: false, notification: doc };
}

export async function markNotificationRead(id: string, userId: string): Promise<boolean> {
  const db = ensureDatabaseAvailable('markNotificationRead');
  if (db) {
    const res = await db.collection<NotificationRecord>('notifications').updateOne({ _id: id as any, userId }, { $set: { isRead: true } });
    return res.modifiedCount > 0;
  }
  const notif = memNotifications.get(id);
  if (notif && notif.userId === userId) {
    notif.isRead = true;
    return true;
  }
  return false;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const db = ensureDatabaseAvailable('markAllNotificationsRead');
  if (db) {
    const res = await db.collection<NotificationRecord>('notifications').updateMany({ userId, isRead: false }, { $set: { isRead: true } });
    return res.modifiedCount;
  }
  let count = 0;
  for (const n of memNotifications.values()) {
    if (n.userId === userId && !n.isRead) {
      n.isRead = true;
      count++;
    }
  }
  return count;
}

// ==================== IMAGES REPOSITORY ====================

export async function saveImage(img: ImageRecord): Promise<void> {
  const db = ensureDatabaseAvailable('saveImage');
  if (db) {
    await db.collection<ImageRecord>('images').insertOne(img as any);
    return;
  }
  memImages.set(img._id, { ...img });
}

export async function getImage(id: string): Promise<ImageRecord | null> {
  const db = ensureDatabaseAvailable('getImage');
  if (db) {
    return await db.collection<ImageRecord>('images').findOne({ _id: id as any });
  }
  return memImages.get(id) || null;
}

export async function deleteImage(id: string): Promise<boolean> {
  const db = ensureDatabaseAvailable('deleteImage');
  if (db) {
    const res = await db.collection<ImageRecord>('images').deleteOne({ _id: id as any });
    return res.deletedCount > 0;
  }
  return memImages.delete(id);
}

// ==================== TRANSACTIONAL OUTBOX & RETRY REPOSITORY ====================

export const MAX_RETRY_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 1000;
let isRetryWorkerRunning = false;

export function getIsRetryWorkerRunning(): boolean {
  return isRetryWorkerRunning;
}

export async function getAllOutboxNotifications(): Promise<NotificationOutboxRecord[]> {
  const db = ensureDatabaseAvailable('getAllOutboxNotifications');
  if (db) {
    return await db.collection<NotificationOutboxRecord>('notification_outbox').find().toArray();
  }
  return Array.from(memNotificationOutbox.values());
}

export async function queueFailedNotificationToOutbox(
  notif: NotificationRecord,
  errorMsg: string
): Promise<NotificationOutboxRecord> {
  const db = ensureDatabaseAvailable('queueFailedNotificationToOutbox');
  const now = new Date();
  const nextRetryAt = new Date(now.getTime() + BASE_BACKOFF_MS).toISOString();

  const outboxDoc: NotificationOutboxRecord = {
    _id: `outbox_${notif._id}`,
    userId: notif.userId,
    matchId: notif.matchId,
    title: notif.title,
    message: notif.message,
    eventType: notif.eventType || inferEventType(notif.title),
    status: 'RETRYING',
    attempts: 1,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    nextRetryAt,
    lastError: errorMsg,
    createdAt: notif.createdAt || now.toISOString(),
  };

  if (db) {
    await db.collection<NotificationOutboxRecord>('notification_outbox').updateOne(
      { userId: notif.userId, matchId: notif.matchId, title: notif.title },
      { $set: outboxDoc },
      { upsert: true }
    );
    return outboxDoc;
  }
  memNotificationOutbox.set(outboxDoc._id, { ...outboxDoc });
  return outboxDoc;
}

export interface MatchNotificationDispatchResult {
  ownerResult: NotificationInsertResult;
  finderResult: NotificationInsertResult;
  ownerQueuedToOutbox?: boolean;
  finderQueuedToOutbox?: boolean;
}

export async function dispatchIndependentMatchNotifications(params: {
  matchId: string;
  lostItem: ItemRecord;
  foundItem: ItemRecord;
  score: number;
  simulateOwnerError?: boolean;
  simulateFinderError?: boolean;
}): Promise<MatchNotificationDispatchResult> {
  const { matchId, lostItem, foundItem, score, simulateOwnerError, simulateFinderError } = params;
  const nowStr = new Date().toISOString();

  const ownerNotif: NotificationRecord = {
    _id: `notif_owner_${crypto.randomUUID()}`,
    userId: lostItem.userId,
    matchId,
    title: 'Possible match found!',
    message: `A found item (${foundItem.itemName}) may match your reported lost ${lostItem.itemName} (${score}% similarity).`,
    eventType: 'MATCH_DETECTED',
    deliveryStatus: 'SENT',
    attempts: 1,
    isRead: false,
    createdAt: nowStr,
  };

  const finderNotif: NotificationRecord = {
    _id: `notif_finder_${crypto.randomUUID()}`,
    userId: foundItem.userId,
    matchId,
    title: 'Possible match found!',
    message: `Your found item (${foundItem.itemName}) may match a reported lost ${lostItem.itemName} (${score}% similarity).`,
    eventType: 'MATCH_DETECTED',
    deliveryStatus: 'SENT',
    attempts: 1,
    isRead: false,
    createdAt: nowStr,
  };

  let ownerResult: NotificationInsertResult;
  let ownerQueued = false;
  try {
    ownerResult = await insertNotification(ownerNotif, {
      simulateDatabaseError: simulateOwnerError,
      throwOnDatabaseError: false,
    });
    if (!ownerResult.success) {
      await queueFailedNotificationToOutbox(ownerNotif, ownerResult.error || 'Failed to insert owner notification');
      ownerQueued = true;
    }
  } catch (err: any) {
    ownerResult = { success: false, inserted: false, duplicate: false, error: err.message };
    await queueFailedNotificationToOutbox(ownerNotif, err.message);
    ownerQueued = true;
  }

  let finderResult: NotificationInsertResult;
  let finderQueued = false;
  try {
    finderResult = await insertNotification(finderNotif, {
      simulateDatabaseError: simulateFinderError,
      throwOnDatabaseError: false,
    });
    if (!finderResult.success) {
      await queueFailedNotificationToOutbox(finderNotif, finderResult.error || 'Failed to insert finder notification');
      finderQueued = true;
    }
  } catch (err: any) {
    finderResult = { success: false, inserted: false, duplicate: false, error: err.message };
    await queueFailedNotificationToOutbox(finderNotif, err.message);
    finderQueued = true;
  }

  return {
    ownerResult,
    finderResult,
    ownerQueuedToOutbox: ownerQueued,
    finderQueuedToOutbox: finderQueued,
  };
}

export async function processNotificationOutbox(
  outboxIds: string[],
  simulateFailure = false
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  const nowStr = new Date().toISOString();
  const db = ensureDatabaseAvailable('processNotificationOutbox');

  for (const id of outboxIds) {
    let outboxRecord: NotificationOutboxRecord | null = null;
    if (db) {
      outboxRecord = await db.collection<NotificationOutboxRecord>('notification_outbox').findOne({ _id: id as any });
    } else {
      outboxRecord = memNotificationOutbox.get(id) || null;
    }

    if (!outboxRecord || outboxRecord.status === 'SENT' || outboxRecord.status === 'PROCESSED') {
      continue;
    }

    if (simulateFailure) {
      outboxRecord.attempts = (outboxRecord.attempts || 0) + 1;
      outboxRecord.status = outboxRecord.attempts >= (outboxRecord.maxAttempts || MAX_RETRY_ATTEMPTS) ? 'FAILED' : 'RETRYING';
      const backoff = BASE_BACKOFF_MS * Math.pow(2, outboxRecord.attempts - 1);
      outboxRecord.nextRetryAt = new Date(Date.now() + backoff).toISOString();
      outboxRecord.lastError = 'Simulated notification dispatch failure (Outbox resilient)';
      if (db) {
        await db.collection('notification_outbox').updateOne(
          { _id: id as any },
          { $set: { attempts: outboxRecord.attempts, status: outboxRecord.status, nextRetryAt: outboxRecord.nextRetryAt, lastError: outboxRecord.lastError } }
        );
      } else {
        memNotificationOutbox.set(id, outboxRecord);
      }
      failed++;
      continue;
    }

    try {
      // Deliver in-app notification idempotently
      const notifId = `notif_${outboxRecord._id.replace('outbox_', '')}`;
      const insRes = await insertNotification({
        _id: notifId,
        userId: outboxRecord.userId,
        matchId: outboxRecord.matchId,
        title: outboxRecord.title,
        message: outboxRecord.message,
        eventType: outboxRecord.eventType,
        deliveryStatus: 'SENT',
        attempts: (outboxRecord.attempts || 0) + 1,
        isRead: false,
        createdAt: nowStr,
      });

      if (insRes.success) {
        outboxRecord.status = 'SENT';
        outboxRecord.processedAt = nowStr;
        outboxRecord.attempts = (outboxRecord.attempts || 0) + 1;
        outboxRecord.lastError = undefined;

        if (db) {
          await db.collection('notification_outbox').updateOne(
            { _id: id as any },
            { $set: { status: 'SENT', processedAt: nowStr, attempts: outboxRecord.attempts } }
          );
        } else {
          memNotificationOutbox.set(id, outboxRecord);
        }
        processed++;
      } else {
        throw new Error(insRes.error || 'Failed to insert notification');
      }
    } catch (err: any) {
      outboxRecord.attempts = (outboxRecord.attempts || 0) + 1;
      const maxAtt = outboxRecord.maxAttempts || MAX_RETRY_ATTEMPTS;
      outboxRecord.status = outboxRecord.attempts >= maxAtt ? 'FAILED' : 'RETRYING';
      const backoff = BASE_BACKOFF_MS * Math.pow(2, outboxRecord.attempts - 1);
      outboxRecord.nextRetryAt = new Date(Date.now() + backoff).toISOString();
      outboxRecord.lastError = err?.message || 'Failed to dispatch notification';

      if (db) {
        await db.collection('notification_outbox').updateOne(
          { _id: id as any },
          { $set: { status: outboxRecord.status, attempts: outboxRecord.attempts, nextRetryAt: outboxRecord.nextRetryAt, lastError: outboxRecord.lastError } }
        );
      } else {
        memNotificationOutbox.set(id, outboxRecord);
      }
      failed++;
    }
  }

  return { processed, failed };
}

export interface RetryWorkerOptions {
  forceAll?: boolean;
  simulateFailureForUser?: string;
  simulatePermanentFailure?: boolean;
}

export interface RetryWorkerResult {
  processed: number;
  succeeded: number;
  failedPermanently: number;
  stillRetrying: number;
  skippedNotDue: number;
}

export async function processNotificationRetries(options?: RetryWorkerOptions): Promise<RetryWorkerResult> {
  if (isRetryWorkerRunning) {
    return { processed: 0, succeeded: 0, failedPermanently: 0, stillRetrying: 0, skippedNotDue: 0 };
  }

  isRetryWorkerRunning = true;
  try {
    const db = ensureDatabaseAvailable('processNotificationRetries');
    let records: NotificationOutboxRecord[] = [];

    if (db) {
      records = await db.collection<NotificationOutboxRecord>('notification_outbox')
        .find({ status: { $in: ['PENDING', 'RETRYING', 'FAILED'] } })
        .toArray();
    } else {
      records = Array.from(memNotificationOutbox.values()).filter(
        r => r.status === 'PENDING' || r.status === 'RETRYING' || r.status === 'FAILED'
      );
    }

    let processed = 0;
    let succeeded = 0;
    let failedPermanently = 0;
    let stillRetrying = 0;
    let skippedNotDue = 0;

    const now = Date.now();

    for (const record of records) {
      const maxAtt = record.maxAttempts || MAX_RETRY_ATTEMPTS;

      // 1. If already exceeded max attempts, finalize to FAILED
      if (record.attempts >= maxAtt) {
        if (record.status !== 'FAILED') {
          record.status = 'FAILED';
          record.lastError = `Maximum retry limit (${maxAtt}) reached without delivery.`;
          if (db) {
            await db.collection('notification_outbox').updateOne(
              { _id: record._id as any },
              { $set: { status: 'FAILED', lastError: record.lastError } }
            );
          } else {
            memNotificationOutbox.set(record._id, record);
          }
        }
        failedPermanently++;
        continue;
      }

      // 2. Check backoff schedule: if not due and forceAll is false, skip
      if (!options?.forceAll && record.nextRetryAt && new Date(record.nextRetryAt).getTime() > now) {
        skippedNotDue++;
        continue;
      }

      processed++;

      // 3. Simulated failure check
      const shouldSimulateFailure =
        Boolean(options?.simulatePermanentFailure) ||
        (options?.simulateFailureForUser ? options.simulateFailureForUser === record.userId : false);

      if (shouldSimulateFailure) {
        record.attempts += 1;
        if (record.attempts >= maxAtt) {
          record.status = 'FAILED';
          record.lastError = `Maximum retry limit (${maxAtt}) reached after simulated failure.`;
          failedPermanently++;
        } else {
          record.status = 'RETRYING';
          const backoff = BASE_BACKOFF_MS * Math.pow(2, record.attempts - 1);
          record.nextRetryAt = new Date(Date.now() + backoff).toISOString();
          record.lastError = 'Simulated delivery failure during retry attempt.';
          stillRetrying++;
        }

        if (db) {
          await db.collection('notification_outbox').updateOne(
            { _id: record._id as any },
            { $set: { status: record.status, attempts: record.attempts, nextRetryAt: record.nextRetryAt, lastError: record.lastError } }
          );
        } else {
          memNotificationOutbox.set(record._id, record);
        }
        continue;
      }

      // 4. Attempt delivery
      const notifId = `notif_${record._id.replace('outbox_', '')}`;
      const insRes = await insertNotification({
        _id: notifId,
        userId: record.userId,
        matchId: record.matchId,
        title: record.title,
        message: record.message,
        eventType: record.eventType,
        deliveryStatus: 'SENT',
        attempts: record.attempts + 1,
        isRead: false,
        createdAt: new Date().toISOString(),
      });

      if (insRes.success) {
        record.status = 'SENT';
        record.attempts += 1;
        record.processedAt = new Date().toISOString();
        record.lastError = undefined;
        succeeded++;

        if (db) {
          await db.collection('notification_outbox').updateOne(
            { _id: record._id as any },
            { $set: { status: 'SENT', processedAt: record.processedAt, attempts: record.attempts } }
          );
        } else {
          memNotificationOutbox.set(record._id, record);
        }
      } else {
        record.attempts += 1;
        if (record.attempts >= maxAtt) {
          record.status = 'FAILED';
          record.lastError = insRes.error || `Maximum retry limit (${maxAtt}) reached.`;
          failedPermanently++;
        } else {
          record.status = 'RETRYING';
          const backoff = BASE_BACKOFF_MS * Math.pow(2, record.attempts - 1);
          record.nextRetryAt = new Date(Date.now() + backoff).toISOString();
          record.lastError = insRes.error;
          stillRetrying++;
        }

        if (db) {
          await db.collection('notification_outbox').updateOne(
            { _id: record._id as any },
            { $set: { status: record.status, attempts: record.attempts, nextRetryAt: record.nextRetryAt, lastError: record.lastError } }
          );
        } else {
          memNotificationOutbox.set(record._id, record);
        }
      }
    }

    return { processed, succeeded, failedPermanently, stillRetrying, skippedNotDue };
  } finally {
    isRetryWorkerRunning = false;
  }
}

export async function retryFailedOutboxNotifications(): Promise<{ retried: number; succeeded: number }> {
  const result = await processNotificationRetries({ forceAll: true });
  return { retried: result.processed, succeeded: result.succeeded };
}

// ==================== STEP 3: ATOMIC RECOVERY COORDINATOR ====================

export async function executeAtomicRecovery(params: AtomicRecoveryParams): Promise<AtomicRecoveryResult> {
  const { matchId, actor, note, forceFailStep, simulatedNotificationFailure } = params;

  // 1. Concurrency control: prevent simultaneous recoveries on the same match
  if (activeRecoveryLocks.has(matchId)) {
    return {
      success: false,
      errorCode: 'CONCURRENT_REQUEST',
      error: 'A recovery transaction is already executing for this match. Please wait for it to complete.',
    };
  }

  activeRecoveryLocks.add(matchId);

  try {
    // 2. Fetch and validate Match record
    const match = await findMatchById(matchId);
    if (!match) {
      return {
        success: false,
        errorCode: 'MATCH_NOT_FOUND',
        error: `Match record "${matchId}" does not exist.`,
      };
    }

    // 3. Idempotency safeguard: if already RECLAIMED, return idempotent success
    if (match.status === 'RECLAIMED') {
      return {
        success: true,
        alreadyReclaimed: true,
        match,
        error: 'Match is already in RECLAIMED status. No duplicate recovery performed.',
      };
    }

    // 4. State validation: can ONLY recover if currently in VERIFIED state
    if (match.status !== 'VERIFIED') {
      return {
        success: false,
        errorCode: 'INVALID_STATE',
        error: `Cannot reclaim item from status "${match.status}". Recovery strictly requires status to be "VERIFIED".`,
      };
    }

    // 5. Authorization validation: Verifier, Admin, or verified participant
    const isAuthorized =
      actor.role === 'VERIFIER' ||
      actor.role === 'ADMIN' ||
      actor.id === match.ownerId ||
      actor.id === match.finderId;

    if (!isAuthorized) {
      return {
        success: false,
        errorCode: 'UNAUTHORIZED',
        error: 'Unauthorized: Only an authorized Campus Verifier, Administrator, or match participant can confirm recovery.',
      };
    }

    // 6. Validate Associated Records: LOST Item
    const lostItem = await findItemById(match.lostItemId);
    if (!lostItem) {
      return {
        success: false,
        errorCode: 'MISSING_LOST_ITEM',
        error: `Recovery aborted: Referenced LOST item "${match.lostItemId}" does not exist in database.`,
      };
    }
    if (lostItem.reportType !== 'LOST') {
      return {
        success: false,
        errorCode: 'INVALID_ITEM_RELATION',
        error: `Integrity error: Referenced item "${match.lostItemId}" has reportType "${lostItem.reportType}", expected LOST.`,
      };
    }

    // 7. Validate Associated Records: FOUND Item
    const foundItem = await findItemById(match.foundItemId);
    if (!foundItem) {
      return {
        success: false,
        errorCode: 'MISSING_FOUND_ITEM',
        error: `Recovery aborted: Referenced FOUND item "${match.foundItemId}" does not exist in database.`,
      };
    }
    if (foundItem.reportType !== 'FOUND') {
      return {
        success: false,
        errorCode: 'INVALID_ITEM_RELATION',
        error: `Integrity error: Referenced item "${match.foundItemId}" has reportType "${foundItem.reportType}", expected FOUND.`,
      };
    }

    // 8. Prepare immutable audit record and outbox notification records
    const nowStr = new Date().toISOString();
    const auditEntry: MatchAuditEntry = {
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'ITEM_RECLAIMED',
      previousStatus: 'VERIFIED',
      newStatus: 'RECLAIMED',
      timestamp: nowStr,
      note: note || `Handover completed and item officially marked as Reclaimed by ${actor.name} (${actor.role}).`,
    };

    const ownerOutboxId = `outbox_owner_${crypto.randomUUID()}`;
    const finderOutboxId = `outbox_finder_${crypto.randomUUID()}`;

    const ownerOutbox: NotificationOutboxRecord = {
      _id: ownerOutboxId,
      userId: match.ownerId,
      matchId: match._id,
      title: 'Item Successfully Reclaimed! 🏆',
      message: 'Congratulations! Your lost item has been officially reunited and closed.',
      eventType: 'ITEM_RECLAIMED',
      status: 'PENDING',
      attempts: 0,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      createdAt: nowStr,
    };

    const finderOutbox: NotificationOutboxRecord = {
      _id: finderOutboxId,
      userId: match.finderId,
      matchId: match._id,
      title: 'Thank You! Item Reclaimed 🤝',
      message: 'The item you found has been successfully reunited with its rightful owner.',
      eventType: 'ITEM_RECLAIMED',
      status: 'PENDING',
      attempts: 0,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      createdAt: nowStr,
    };

    const db = getConnectedDb();
    const txSupport = await checkTransactionSupport();

    // =========================================================================
    // EXECUTION PATH A: Live MongoDB Atlas Multi-Document Transaction with Session
    // =========================================================================
    if (db && txSupport.supported) {
      try {
        await withMongoTransaction(async session => {
          if (forceFailStep === 'MATCH') {
            throw new Error('Simulated failure during match status update');
          }
          await db.collection<MatchRecord>('matches').updateOne(
            { _id: match._id as any, status: 'VERIFIED' },
            {
              $set: { status: 'RECLAIMED', reclaimedAt: nowStr, updatedAt: nowStr },
              $push: { auditLog: auditEntry as any },
            },
            { session }
          );

          if (forceFailStep === 'LOST') {
            throw new Error('Simulated failure during LOST item status update');
          }
          await db.collection<ItemRecord>('items').updateOne(
            { _id: match.lostItemId as any },
            { $set: { status: 'RECLAIMED', updatedAt: nowStr } },
            { session }
          );

          if (forceFailStep === 'FOUND') {
            throw new Error('Simulated failure during FOUND item status update');
          }
          await db.collection<ItemRecord>('items').updateOne(
            { _id: match.foundItemId as any },
            { $set: { status: 'RECLAIMED', updatedAt: nowStr } },
            { session }
          );

          if (forceFailStep === 'OUTBOX') {
            throw new Error('Simulated failure during notification outbox write');
          }
          await db.collection<NotificationOutboxRecord>('notification_outbox').insertMany(
            [ownerOutbox, finderOutbox],
            { session }
          );
        });
      } catch (txError: any) {
        return {
          success: false,
          errorCode: 'TRANSACTION_FAILED',
          error: `MongoDB transaction aborted: ${txError.message}. No partial recovery committed.`,
        };
      }

      // Outbox delivery after successful commit
      await processNotificationOutbox([ownerOutboxId, finderOutboxId], simulatedNotificationFailure);

      const updated = await findMatchById(matchId);
      return {
        success: true,
        match: updated!,
        outboxIds: [ownerOutboxId, finderOutboxId],
        transactionType: 'MONGODB_REPLICA_TRANSACTION',
      };
    }

    // =========================================================================
    // EXECUTION PATH B: Dual-Mode Snapshot Isolation with Explicit Rollback
    // =========================================================================
    // Save snapshots before mutating in-memory records
    const snapshotMatch = JSON.parse(JSON.stringify(match));
    const snapshotLost = JSON.parse(JSON.stringify(lostItem));
    const snapshotFound = JSON.parse(JSON.stringify(foundItem));

    try {
      if (forceFailStep === 'MATCH') {
        throw new Error('Simulated failure during match status update');
      }
      const inMemMatch = memMatches.get(matchId)!;
      inMemMatch.status = 'RECLAIMED';
      inMemMatch.reclaimedAt = nowStr;
      inMemMatch.updatedAt = nowStr;
      if (!inMemMatch.auditLog) inMemMatch.auditLog = [];
      inMemMatch.auditLog.push(auditEntry);

      if (forceFailStep === 'LOST') {
        throw new Error('Simulated failure during LOST item status update');
      }
      const inMemLost = memItems.get(match.lostItemId)!;
      inMemLost.status = 'RECLAIMED';
      inMemLost.updatedAt = nowStr;

      if (forceFailStep === 'FOUND') {
        throw new Error('Simulated failure during FOUND item status update');
      }
      const inMemFound = memItems.get(match.foundItemId)!;
      inMemFound.status = 'RECLAIMED';
      inMemFound.updatedAt = nowStr;

      if (forceFailStep === 'OUTBOX') {
        throw new Error('Simulated failure during outbox write');
      }
      memNotificationOutbox.set(ownerOutboxId, { ...ownerOutbox });
      memNotificationOutbox.set(finderOutboxId, { ...finderOutbox });
    } catch (abortErr: any) {
      // COMPLETE ROLLBACK: restore all snapshots so zero partial records linger
      memMatches.set(matchId, snapshotMatch);
      memItems.set(match.lostItemId, snapshotLost);
      memItems.set(match.foundItemId, snapshotFound);
      memNotificationOutbox.delete(ownerOutboxId);
      memNotificationOutbox.delete(finderOutboxId);

      return {
        success: false,
        errorCode: 'TRANSACTION_FAILED',
        error: `Recovery operation aborted: ${abortErr.message}. All state changes rolled back.`,
      };
    }

    // Process notification outbox after commit
    await processNotificationOutbox([ownerOutboxId, finderOutboxId], simulatedNotificationFailure);

    const updated = await findMatchById(matchId);
    return {
      success: true,
      match: updated!,
      outboxIds: [ownerOutboxId, finderOutboxId],
      transactionType: 'SNAPSHOT_ISOLATION_FALLBACK',
    };
  } finally {
    activeRecoveryLocks.delete(matchId);
  }
}

// Reset fallback store for unit test suites
export function resetFallbackDataForTesting(): void {
  memUsers.clear();
  memItems.clear();
  memMatches.clear();
  memNotifications.clear();
  memNotificationOutbox.clear();
  memImages.clear();
  activeRecoveryLocks.clear();
  isRetryWorkerRunning = false;
  fallbackInitialized = false;
  initFallbackData();
}

