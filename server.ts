import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { initDatabase, isAtlasConnected, pingAtlas, DB_NAME, MONGO_URI, JWT_SECRET, checkTransactionSupport } from './db/mongo.ts';
import {
  UserRecord,
  ItemRecord,
  MatchRecord,
  MatchStatus,
  ScoreBreakdown,
  DatabaseDisconnectedError,
  findUserByEmail,
  findUserById,
  insertUser,
  getAllActiveItems,
  findItems,
  findItemsByUser,
  findItemById,
  insertItem,
  updateItemStatus,
  findMatchesForUser,
  findMatchByItems,
  findMatchById,
  upsertMatch,
  updateMatchStatus,
  updateMatchesForItemStatus,
  findNotificationsForUser,
  getUnreadNotificationCount,
  notificationExistsForMatch,
  insertNotification,
  markNotificationRead,
  markAllNotificationsRead,
  saveImage,
  getImage,
  deleteImage,
  getAllMatchesCount,
  isUsingFallback,
  getAllMatches,
  MatchAuditEntry,
  UserRole,
  executeAtomicRecovery,
  getAllOutboxNotifications,
  retryFailedOutboxNotifications,
  getActiveRecoveryLocksCount,
  dispatchIndependentMatchNotifications,
  processNotificationRetries,
  getIsRetryWorkerRunning,
  MAX_RETRY_ATTEMPTS,
} from './db/repository.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

// ==================== SVG ASSET GENERATOR (DEV SEED ONLY) ====================

function createSvgImageBuffer(icon: string, title: string, bg: string, fg: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="${bg}" rx="16"/>
    <circle cx="300" cy="180" r="70" fill="rgba(255,255,255,0.2)"/>
    <text x="300" y="200" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="70" text-anchor="middle">${icon}</text>
    <text x="300" y="290" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="24" font-weight="600" fill="${fg}" text-anchor="middle">${title}</text>
    <text x="300" y="325" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" fill="${fg}" opacity="0.8" text-anchor="middle">ReClaim Verified Item</text>
  </svg>`;
  return Buffer.from(svg, 'utf-8');
}

// ==================== MEMBER 2: SMART MATCHING ENGINE ====================
import { calculateMatchScore } from './matching/engine.ts';

// Module C: Bi-directional Automatic Match Detection & Dual Notifications (Owner + Finder)
export async function runMatchingForItem(newItem: ItemRecord): Promise<MatchRecord[]> {
  const createdMatches: MatchRecord[] = [];
  const minThreshold = 40;

  const allActiveItems = await getAllActiveItems();

  if (newItem.reportType === 'FOUND') {
    const candidateLost = allActiveItems.filter(i => i.reportType === 'LOST' && i.userId !== newItem.userId);
    for (const lostItem of candidateLost) {
      const matchResult = calculateMatchScore(lostItem, newItem);
      if (matchResult && matchResult.score >= minThreshold) {
        const existing = await findMatchByItems(lostItem._id, newItem._id);
        const matchId = existing ? existing._id : `match_${crypto.randomUUID()}`;
        const nowStr = new Date().toISOString();

        const matchDoc: MatchRecord = {
          _id: matchId,
          lostItemId: lostItem._id,
          foundItemId: newItem._id,
          ownerId: lostItem.userId,
          finderId: newItem.userId,
          score: matchResult.score,
          breakdown: matchResult.breakdown,
          status: existing ? existing.status : 'PENDING',
          createdAt: existing ? existing.createdAt : nowStr,
          updatedAt: nowStr,
        };

        await upsertMatch(matchDoc);
        createdMatches.push(matchDoc);

        // Dispatch notifications to owner and finder independently with outbox fallback
        await dispatchIndependentMatchNotifications({
          matchId,
          lostItem,
          foundItem: newItem,
          score: matchResult.score,
        });
      }
    }
  } else if (newItem.reportType === 'LOST') {
    const candidateFound = allActiveItems.filter(i => i.reportType === 'FOUND' && i.userId !== newItem.userId);
    for (const foundItem of candidateFound) {
      const matchResult = calculateMatchScore(newItem, foundItem);
      if (matchResult && matchResult.score >= minThreshold) {
        const existing = await findMatchByItems(newItem._id, foundItem._id);
        const matchId = existing ? existing._id : `match_${crypto.randomUUID()}`;
        const nowStr = new Date().toISOString();

        const matchDoc: MatchRecord = {
          _id: matchId,
          lostItemId: newItem._id,
          foundItemId: foundItem._id,
          ownerId: newItem.userId,
          finderId: foundItem.userId,
          score: matchResult.score,
          breakdown: matchResult.breakdown,
          status: existing ? existing.status : 'PENDING',
          createdAt: existing ? existing.createdAt : nowStr,
          updatedAt: nowStr,
        };

        await upsertMatch(matchDoc);
        createdMatches.push(matchDoc);

        // Dispatch notifications to owner and finder independently with outbox fallback
        await dispatchIndependentMatchNotifications({
          matchId,
          lostItem: newItem,
          foundItem,
          score: matchResult.score,
        });
      }
    }
  }

  return createdMatches;
}

export async function recalculateAllMatches(): Promise<number> {
  const activeItems = await getAllActiveItems();
  const lostList = activeItems.filter(i => i.reportType === 'LOST');
  const foundList = activeItems.filter(i => i.reportType === 'FOUND');
  let count = 0;

  for (const lost of lostList) {
    for (const found of foundList) {
      if (lost.userId === found.userId) continue;
      const res = calculateMatchScore(lost, found);
      if (res && res.score >= 40) {
        const existing = await findMatchByItems(lost._id, found._id);
        const matchId = existing ? existing._id : `match_${crypto.randomUUID()}`;
        const nowStr = new Date().toISOString();

        const matchDoc: MatchRecord = {
          _id: matchId,
          lostItemId: lost._id,
          foundItemId: found._id,
          ownerId: lost.userId,
          finderId: found.userId,
          score: res.score,
          breakdown: res.breakdown,
          status: existing ? existing.status : 'PENDING',
          createdAt: existing ? existing.createdAt : nowStr,
          updatedAt: nowStr,
        };

        await upsertMatch(matchDoc);
        count++;

        // Dispatch notifications to owner and finder independently with outbox fallback
        await dispatchIndependentMatchNotifications({
          matchId,
          lostItem: lost,
          foundItem: found,
          score: res.score,
        });
      }
    }
  }
  return count;
}

// ==================== EXPLICIT DEV SEED FUNCTION ====================
// Note: Only invoked on explicit request or dev endpoint; NEVER automatically in production!
async function seedDemoData() {
  const now = new Date();
  const hashedPassword = await bcrypt.hash('Password123', 10);

  const alexId = 'user_demo_01';
  if (!(await findUserByEmail('demo@example.com'))) {
    await insertUser({
      _id: alexId,
      name: 'Alex Morgan',
      email: 'demo@example.com',
      passwordHash: hashedPassword,
      createdAt: new Date(now.getTime() - 86400000 * 10).toISOString(),
    });
  }

  const ananyaId = 'user_ananya_02';
  if (!(await findUserByEmail('ananya@example.com'))) {
    await insertUser({
      _id: ananyaId,
      name: 'Ananya Sharma',
      email: 'ananya@example.com',
      passwordHash: hashedPassword,
      createdAt: new Date(now.getTime() - 86400000 * 8).toISOString(),
    });
  }

  const rahulId = 'user_rahul_03';
  if (!(await findUserByEmail('rahul@example.com'))) {
    await insertUser({
      _id: rahulId,
      name: 'Rahul Varma',
      email: 'rahul@example.com',
      passwordHash: hashedPassword,
      role: 'USER',
      createdAt: new Date(now.getTime() - 86400000 * 5).toISOString(),
    });
  }

  const verifierId = 'user_verifier_04';
  if (!(await findUserByEmail('verifier@example.com'))) {
    await insertUser({
      _id: verifierId,
      name: 'Vikram Roy (Campus Verifier)',
      email: 'verifier@example.com',
      passwordHash: hashedPassword,
      role: 'VERIFIER',
      createdAt: new Date(now.getTime() - 86400000 * 12).toISOString(),
    });
  }

  const imgAnanyaLostWallet = 'img_ananya_lost_wallet';
  if (!(await getImage(imgAnanyaLostWallet))) {
    await saveImage({
      _id: imgAnanyaLostWallet,
      filename: 'ananya_wallet.svg',
      contentType: 'image/svg+xml',
      data: createSvgImageBuffer('👛', 'Black Leather Wallet', '#292524', '#fafaf9'),
      ownerId: ananyaId,
    });
  }

  const imgRahulFoundWallet = 'img_rahul_found_wallet';
  if (!(await getImage(imgRahulFoundWallet))) {
    await saveImage({
      _id: imgRahulFoundWallet,
      filename: 'rahul_found_wallet.svg',
      contentType: 'image/svg+xml',
      data: createSvgImageBuffer('👛', 'Found Black Wallet', '#1c1917', '#f5f5f4'),
      ownerId: rahulId,
    });
  }

  if (!(await findItemById('item_ananya_lost_01'))) {
    await insertItem({
      _id: 'item_ananya_lost_01',
      userId: ananyaId,
      reportType: 'LOST',
      itemName: 'Wallet',
      category: 'Accessories',
      description: 'Black leather wallet with a small silver logo and cards inside.',
      color: 'Black',
      location: 'MVP Colony',
      date: new Date(now.getTime() - 86400000 * 2).toISOString(),
      imageId: imgAnanyaLostWallet,
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
      updatedAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    });
  }

  if (!(await findItemById('item_rahul_found_02'))) {
    await insertItem({
      _id: 'item_rahul_found_02',
      userId: rahulId,
      reportType: 'FOUND',
      itemName: 'Wallet',
      category: 'Accessories',
      description: 'Black wallet with silver logo, found near sidewalk bench.',
      color: 'Black',
      location: 'Near MVP Colony',
      date: new Date(now.getTime() - 86400000 * 2).toISOString(),
      imageId: imgRahulFoundWallet,
      status: 'OPEN',
      createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
      updatedAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
    });
  }

  await recalculateAllMatches();
  console.log('[ReClaim Dev Seeder] Seeded demo items and verified matches.');
}

// ==================== APP & MIDDLEWARE ====================

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
});

function jsonItem(item: ItemRecord) {
  return {
    _id: item._id,
    userId: item.userId,
    reportType: item.reportType,
    itemName: item.itemName,
    category: item.category,
    description: item.description,
    color: item.color,
    location: item.location,
    date: item.date,
    imageUrl: item.imageId ? `/api/items/image/${item.imageId}` : null,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

interface AuthenticatedRequest extends Request {
  currentUser?: UserRecord;
  file?: any;
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication token is required.' });
  }

  const token = authHeader.slice(7).trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await findUserById(payload.userId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User account was not found.' });
    }
    req.currentUser = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired authentication token.' });
  }
}

function validText(value: any, label: string, maxLength: number, required = true): string {
  const str = String(value ?? '').trim();
  if (required && !str) {
    throw new Error(`${label} is required.`);
  }
  if (str.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return str;
}

// ==================== REST APIS ====================

// Fix 2: Honest Health Check performing real ping command against Atlas
app.get('/api/health', async (_req: Request, res: Response) => {
  const ping = await pingAtlas();
  const atlas = isAtlasConnected() && ping.ok;

  const responsePayload = {
    status: 'healthy',
    server: 'running',
    database: {
      connected: atlas,
      mode: atlas ? 'Atlas Cloud Cluster' : 'Local Fallback Storage Active',
      provider: 'MongoDB Atlas',
      cluster: 'reclaim-cluster.3bnnmc9.mongodb.net',
      databaseName: DB_NAME,
      ping: ping.ok ? 'connected' : 'network_restricted',
      latencyMs: ping.latencyMs,
      message: atlas
        ? `Connected to MongoDB Atlas (${DB_NAME})`
        : 'Active on high-performance local storage. To connect to Cloud Atlas, add deployment host IP in MongoDB Atlas Network Access.',
    },
    member2Modules: {
      smartMatching: 'active',
      scoringEngine: 'active',
      notifications: 'active',
      bidirectionalTrigger: 'active',
    },
    timestamp: new Date().toISOString(),
  };

  res.json(responsePayload);
});

// Explicit Dev Seed Endpoint (Restricted to development environments only)
app.post('/api/dev/seed', async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, message: 'Dev seed endpoint is disabled in production environments.' });
  }
  try {
    await seedDemoData();
    res.json({ success: true, message: 'Sample DTI test records seeded successfully into database.' });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, error: err.name, message: err.message });
  }
});

// Auth: Register
app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const { name: rawName, email: rawEmail, password: rawPassword } = req.body || {};
    const name = validText(rawName, 'Name', 80);
    const email = validText(rawEmail, 'Email', 254).toLowerCase();
    const password = validText(rawPassword, 'Password', 128);

    if (!email.includes('@') || !email.split('@')[1]?.includes('.')) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must contain at least 8 characters.' });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    const newUser: UserRecord = {
      _id: userId,
      name,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    await insertUser(newUser);

    return res.status(201).json({
      success: true,
      message: 'Registration successful. You can now log in.',
      userId,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message || 'Registration failed.' });
  }
});

// Auth: Login
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, password: rawPassword } = req.body || {};
    const email = String(rawEmail || '').trim().toLowerCase();
    const password = String(rawPassword || '');

    const foundUser = await findUserByEmail(email);
    if (!foundUser) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, foundUser.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }

    const token = jwt.sign({ userId: foundUser._id }, JWT_SECRET, { expiresIn: '24h' });

    return res.json({
      success: true,
      token,
      user: {
        id: foundUser._id,
        name: foundUser.name,
        email: foundUser.email,
        role: foundUser.role || 'USER',
      },
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    return res.status(500).json({ success: false, message: err.message || 'Login failed.' });
  }
});

// Auth: Me
app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const user = req.currentUser!;
  res.json({
    success: true,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role || 'USER',
    },
  });
});

// ==================== ITEMS & REPORTING (MEMBER 1 INTEGRATION) ====================

app.get('/api/items', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reportType = String(req.query.reportType || '').trim().toUpperCase();
    const status = String(req.query.status || '').trim().toUpperCase();

    if (reportType && reportType !== 'LOST' && reportType !== 'FOUND') {
      return res.status(400).json({ success: false, message: 'reportType must be LOST or FOUND.' });
    }
    if (status && !['OPEN', 'CLAIMED', 'RECLAIMED', 'CLOSED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter.' });
    }

    const itemsList = await findItems({ reportType, status });

    res.json({
      success: true,
      count: itemsList.length,
      items: itemsList.map(jsonItem),
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/items/my-reports', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.currentUser!._id;
    const userReports = await findItemsByUser(userId);

    res.json({
      success: true,
      items: userReports.map(jsonItem),
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create item: triggers Member 2 Smart Matching
app.post('/api/items', requireAuth, upload.single('image'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = req.body || {};
    const reportType = validText(data.reportType, 'Report type', 10).toUpperCase() as 'LOST' | 'FOUND';
    if (reportType !== 'LOST' && reportType !== 'FOUND') {
      return res.status(400).json({ success: false, message: 'reportType must be LOST or FOUND.' });
    }

    const itemName = validText(data.itemName, 'Item name', 100);
    const category = validText(data.category, 'Category', 60);
    const description = validText(data.description, 'Description', 1000);
    const color = validText(data.color, 'Color', 50);
    const location = validText(data.location, 'Location', 200);
    const dateText = validText(data.date, 'Date', 40);

    const incidentDate = new Date(dateText);
    if (isNaN(incidentDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Enter a valid incident date.' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'Please upload an item photograph.' });
    }

    const extension = file.originalname.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return res.status(400).json({ success: false, message: 'Image must be PNG, JPG, JPEG or WEBP.' });
    }

    const imageId = crypto.randomUUID();
    await saveImage({
      _id: imageId,
      filename: file.originalname,
      contentType: file.mimetype || 'application/octet-stream',
      data: file.buffer,
      ownerId: req.currentUser!._id,
    });

    const now = new Date().toISOString();
    const itemId = crypto.randomUUID();
    const newItem: ItemRecord = {
      _id: itemId,
      userId: req.currentUser!._id,
      reportType,
      itemName,
      category,
      description,
      color,
      location,
      date: incidentDate.toISOString(),
      imageId,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    };

    try {
      await insertItem(newItem);
    } catch (insertErr) {
      // Clean up newly uploaded image to prevent orphaned records
      await deleteImage(imageId).catch(() => {});
      throw insertErr;
    }

    // Run Member 2 automatic matching engine with isolated error handling
    let newMatches: MatchRecord[] = [];
    let matchingNotice = '';
    try {
      newMatches = await runMatchingForItem(newItem);
    } catch (matchErr: any) {
      console.warn('[Matching Engine Notice]: Auto-matching deferred or failed:', matchErr?.message);
      matchingNotice = ' (Matching check pending)';
    }

    res.status(201).json({
      success: true,
      message: `${reportType.charAt(0) + reportType.slice(1).toLowerCase()} item report submitted successfully.${newMatches.length > 0 ? ` (${newMatches.length} potential matches detected!)` : matchingNotice}`,
      item: jsonItem(newItem),
      matchesDetected: newMatches.length,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(400).json({ success: false, message: err.message || 'Could not save report.' });
  }
});

// Single item
app.get('/api/items/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const item = await findItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item report not found.' });
    }
    res.json({ success: true, item: jsonItem(item) });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update item status
app.patch('/api/items/:id/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const item = await findItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item report not found.' });
    }

    if (item.userId !== req.currentUser!._id) {
      return res.status(403).json({ success: false, message: 'You can update only your own item reports.' });
    }

    const { status: rawStatus } = req.body || {};
    const status = String(rawStatus || '').trim().toUpperCase() as ItemRecord['status'];
    if (!['OPEN', 'CLAIMED', 'RECLAIMED', 'CLOSED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be OPEN, CLAIMED, RECLAIMED or CLOSED.' });
    }

    const updatedItem = await updateItemStatus(item._id, status);

    if (status === 'CLOSED' || status === 'RECLAIMED') {
      await updateMatchesForItemStatus(item._id, status);
    }

    res.json({
      success: true,
      message: 'Report status updated.',
      item: updatedItem ? jsonItem(updatedItem) : null,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Image endpoint
app.get('/api/items/image/:id', async (req: Request, res: Response) => {
  try {
    const image = await getImage(req.params.id);
    if (!image) {
      return res.status(404).json({ success: false, message: 'Image not found.' });
    }
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(image.data);
  } catch (err: any) {
    res.status(503).json({ success: false, message: 'Image service unavailable.' });
  }
});

// ==================== MEMBER 2: MATCHES APIS ====================

async function populateMatch(match: MatchRecord, currentUserId?: string, userRole?: string) {
  const lost = await findItemById(match.lostItemId);
  const found = await findItemById(match.foundItemId);
  const owner = await findUserById(match.ownerId);
  const finder = await findUserById(match.finderId);

  return {
    _id: match._id,
    lostItemId: match.lostItemId,
    foundItemId: match.foundItemId,
    ownerId: match.ownerId,
    finderId: match.finderId,
    score: match.score,
    breakdown: match.breakdown,
    status: match.status,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    isOwner: currentUserId === match.ownerId,
    isFinder: currentUserId === match.finderId,
    isVerifier: userRole === 'VERIFIER' || userRole === 'ADMIN',
    verifiedBy: match.verifiedBy,
    verifiedAt: match.verifiedAt,
    rejectionReason: match.rejectionReason,
    reclaimedAt: match.reclaimedAt,
    // Member 3: Show verification answers only to the owner and verifier
...(currentUserId === match.ownerId ||
  userRole === 'VERIFIER' ||
  userRole === 'ADMIN'
  ? {
      verificationAnswers: match.verificationAnswers || [],
      verificationSubmittedAt: match.verificationSubmittedAt,
    }
  : {}),
    auditLog: match.auditLog || [],
    lostItem: lost ? jsonItem(lost) : null,
    foundItem: found ? jsonItem(found) : null,
    ownerName: owner ? owner.name : 'Owner',
    finderName: finder ? finder.name : 'Finder',
  };
}

// Retrieve matches
app.get('/api/matches', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.currentUser!._id;
    const userRole = req.currentUser?.role || 'USER';
    const isVerifierOrAdmin = userRole === 'VERIFIER' || userRole === 'ADMIN';

    const statusFilter = String(req.query.status || '').trim().toUpperCase();
    const minScore = parseInt(String(req.query.minScore || '0'), 10) || 0;
    const categoryFilter = String(req.query.category || '').trim().toLowerCase();
    const searchFilter = String(req.query.search || '').trim().toLowerCase();

    // Verifiers & Admins can view all candidate matches in the system to verify claims
    let userMatches = isVerifierOrAdmin
      ? await getAllMatches()
      : await findMatchesForUser(userId);

    if (statusFilter) {
      userMatches = userMatches.filter(m => m.status === statusFilter);
    }

    if (minScore > 0) {
      userMatches = userMatches.filter(m => m.score >= minScore);
    }

    let populated = await Promise.all(userMatches.map(m => populateMatch(m, userId, userRole)));

    if (categoryFilter) {
      populated = populated.filter(m =>
        (m.lostItem?.category.toLowerCase() === categoryFilter) ||
        (m.foundItem?.category.toLowerCase() === categoryFilter)
      );
    }

    if (searchFilter) {
      populated = populated.filter(m => {
        const lostText = `${m.lostItem?.itemName || ''} ${m.lostItem?.location || ''} ${m.lostItem?.color || ''} ${m.lostItem?.description || ''}`.toLowerCase();
        const foundText = `${m.foundItem?.itemName || ''} ${m.foundItem?.location || ''} ${m.foundItem?.color || ''} ${m.foundItem?.description || ''}`.toLowerCase();
        return lostText.includes(searchFilter) || foundText.includes(searchFilter);
      });
    }

    populated.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      count: populated.length,
      matches: populated,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Single match
app.get('/api/matches/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const match = await findMatchById(req.params.id);
    if (!match) {
      return res.status(404).json({ success: false, message: 'Match record not found.' });
    }

    const userId = req.currentUser!._id;
    const userRole = req.currentUser?.role || 'USER';
    const isVerifierOrAdmin = userRole === 'VERIFIER' || userRole === 'ADMIN';

    if (match.ownerId !== userId && match.finderId !== userId && !isVerifierOrAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied to this match report.' });
    }

    const populated = await populateMatch(match, userId, userRole);
    res.json({
      success: true,
      match: populated,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update match status with strict verification & recovery role checks and audit trail
app.patch('/api/matches/:id/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const match = await findMatchById(req.params.id);
    if (!match) {
      return res.status(404).json({ success: false, message: 'Match record not found.' });
    }

    const currentUser = req.currentUser!;
    const userId = currentUser._id;
    const userRole = currentUser.role || 'USER';
    const isOwner = match.ownerId === userId;
    const isFinder = match.finderId === userId;
    const isVerifierOrAdmin = userRole === 'VERIFIER' || userRole === 'ADMIN';

    if (!isOwner && !isFinder && !isVerifierOrAdmin) {
      return res.status(403).json({ success: false, message: 'You can update only matches involving your reports or authorized verifications.' });
    }

    const { status: rawStatus, note: rawNote, rejectionReason: rawRejectionReason } = req.body || {};
    const status = String(rawStatus || '').trim().toUpperCase() as MatchStatus;
    const allowedStatuses: MatchStatus[] = ['PENDING', 'CLAIM_IN_PROGRESS', 'VERIFIED', 'REJECTED', 'CLOSED', 'RECLAIMED'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${allowedStatuses.join(', ')}.` });
    }

    const currentStatus = match.status;
    // MEMBER 3: Save ownership verification answers
const rawVerificationAnswers = req.body?.verificationAnswers;

if (rawVerificationAnswers !== undefined) {
  // Only the item owner can submit ownership answers
  if (!isOwner) {
    return res.status(403).json({
      success: false,
      message: 'Only the item owner can submit ownership verification answers.',
    });
  }

  // Answers can only be submitted while verification is in progress
  if (currentStatus !== 'CLAIM_IN_PROGRESS' || status !== 'CLAIM_IN_PROGRESS') {
    return res.status(400).json({
      success: false,
      message: 'Initiate the claim before submitting verification answers.',
    });
  }

  if (
    !Array.isArray(rawVerificationAnswers) ||
    rawVerificationAnswers.length < 1 ||
    rawVerificationAnswers.length > 5
  ) {
    return res.status(400).json({
      success: false,
      message: 'Submit between 1 and 5 verification answers.',
    });
  }

  const verificationAnswers = rawVerificationAnswers.map((entry: any) => ({
    question: typeof entry.question === 'string' ? entry.question.trim().slice(0, 300) : '',
    answer: typeof entry.answer === 'string' ? entry.answer.trim().slice(0, 1000) : '',
  }));

  if (verificationAnswers.some((entry: any) => !entry.question || !entry.answer)) {
    return res.status(400).json({
      success: false,
      message: 'Every verification question must have an answer.',
    });
  }

  const now = new Date().toISOString();

  const auditEntry: MatchAuditEntry = {
    actorId: userId,
    actorName: currentUser.name,
    actorRole: userRole,
    action: 'VERIFICATION_ANSWERS_SUBMITTED',
    previousStatus: currentStatus,
    newStatus: currentStatus,
    timestamp: now,
    note: 'Owner submitted ownership verification answers.',
  };

  const updatedMatch = await updateMatchStatus(
    match._id,
    currentStatus,
    auditEntry,
    {
      verificationAnswers,
      verificationSubmittedAt: now,
    }
  );

  return res.json({
    success: true,
    message: 'Ownership verification answers submitted successfully.',
    match: updatedMatch
      ? await populateMatch(updatedMatch, userId, userRole)
      : null,
  });
}
    if (currentStatus === status) {
      return res.json({
        success: true,
        message: `Match is already ${status}.`,
        match: await populateMatch(match, userId, userRole),
      });
    }

    // Permitted lifecycle state transitions
    const ALLOWED_TRANSITIONS: Record<MatchStatus, MatchStatus[]> = {
      PENDING: ['CLAIM_IN_PROGRESS', 'CLOSED'],
      CLAIM_IN_PROGRESS: ['VERIFIED', 'REJECTED', 'CLOSED'],
      VERIFIED: ['RECLAIMED', 'CLOSED'],
      REJECTED: ['CLOSED', 'PENDING'],
      CLOSED: [],
      RECLAIMED: [],
    };

    const permitted = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!permitted.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status transition from "${currentStatus}" to "${status}". Verification workflow requires initiating claim (CLAIM_IN_PROGRESS) before verification or recovery.`,
      });
    }

    // STRICT ROLE & PERMISSION ENFORCEMENT FOR MEMBER 3 VERIFICATION & RECOVERY
    let actionType = 'STATUS_UPDATE';
    let extraFields: Partial<MatchRecord> = {};
    let note = typeof rawNote === 'string' ? rawNote.trim().slice(0, 500) : '';

    if (status === 'VERIFIED') {
      // ONLY AN AUTHORIZED VERIFIER OR ADMIN CAN APPROVE OWNERSHIP
      if (!isVerifierOrAdmin) {
        return res.status(403).json({
          success: false,
          message: 'Authorization error: Only an authorized Campus Verifier (Member 3) or Administrator can approve ownership verification.',
        });
      }
      actionType = 'VERIFICATION_APPROVED';
      extraFields = {
        verifiedBy: userId,
        verifiedAt: new Date().toISOString(),
      };
      if (!note) note = `Ownership claim verified by ${currentUser.name}.`;

      // Notifications
      const nowStr = new Date().toISOString();
      await insertNotification({
        _id: `notif_${crypto.randomUUID()}`,
        userId: match.ownerId,
        matchId: match._id,
        title: 'Ownership Claim Verified! 🎉',
        message: `Your ownership claim has been verified by ${currentUser.name}. You may proceed to arrange item pickup.`,
        isRead: false,
        createdAt: nowStr,
      });
      await insertNotification({
        _id: `notif_${crypto.randomUUID()}`,
        userId: match.finderId,
        matchId: match._id,
        title: 'Claim Verified by Campus Verifier',
        message: `The claim for your found item has been verified. Please prepare for handover to the verified owner.`,
        isRead: false,
        createdAt: nowStr,
      });
    } else if (status === 'REJECTED') {
      // ONLY AN AUTHORIZED VERIFIER OR ADMIN CAN REJECT A CLAIM
      if (!isVerifierOrAdmin) {
        return res.status(403).json({
          success: false,
          message: 'Authorization error: Only an authorized Campus Verifier (Member 3) or Administrator can reject a claim.',
        });
      }
      const reason = typeof rawRejectionReason === 'string' && rawRejectionReason.trim()
        ? rawRejectionReason.trim().slice(0, 500)
        : (note || 'Verification details did not match found item characteristics.');

      actionType = 'VERIFICATION_REJECTED';
      extraFields = {
        rejectionReason: reason,
      };
      note = `Claim rejected: ${reason}`;

      const nowStr = new Date().toISOString();
      await insertNotification({
        _id: `notif_${crypto.randomUUID()}`,
        userId: match.ownerId,
        matchId: match._id,
        title: 'Ownership Verification Rejected',
        message: `Your claim for item could not be verified: "${reason}". Please review your report details.`,
        isRead: false,
        createdAt: nowStr,
      });
    } else if (status === 'RECLAIMED') {
      // Step 3: Coordinated Atomic Recovery using MongoDB transaction / atomic snapshot isolation
      const recoveryResult = await executeAtomicRecovery({
        matchId: match._id,
        actor: {
          id: userId,
          name: currentUser.name,
          role: userRole,
        },
        note,
      });

      if (!recoveryResult.success) {
        const errorStatusMap: Record<string, number> = {
          INVALID_STATE: 400,
          UNAUTHORIZED: 403,
          MATCH_NOT_FOUND: 404,
          MISSING_LOST_ITEM: 422,
          MISSING_FOUND_ITEM: 422,
          INVALID_ITEM_RELATION: 422,
          CONCURRENT_REQUEST: 409,
          TRANSACTION_FAILED: 500,
        };
        const httpStatus = errorStatusMap[recoveryResult.errorCode || ''] || 400;
        return res.status(httpStatus).json({
          success: false,
          errorCode: recoveryResult.errorCode,
          message: recoveryResult.error || 'Failed to complete item recovery.',
        });
      }

      const populated = await populateMatch(recoveryResult.match!, userId, userRole);
      return res.json({
        success: true,
        alreadyReclaimed: recoveryResult.alreadyReclaimed || false,
        message: recoveryResult.alreadyReclaimed
          ? 'Item is already in RECLAIMED status. No duplicate recovery performed.'
          : 'Recovery completed successfully. Match, Lost report, and Found report updated atomically.',
        match: populated,
        outboxNotificationIds: recoveryResult.outboxIds,
        transactionType: recoveryResult.transactionType,
      });
    } else if (status === 'CLAIM_IN_PROGRESS') {
      actionType = 'CLAIM_INITIATED';
      if (!note) note = `Claim initiated by ${isOwner ? 'owner' : (isFinder ? 'finder' : currentUser.name)}. Ready for Member 3 verification.`;

      const nowStr = new Date().toISOString();
      const notifyTarget = isOwner ? match.finderId : match.ownerId;
      await insertNotification({
        _id: `notif_${crypto.randomUUID()}`,
        userId: notifyTarget,
        matchId: match._id,
        title: 'Claim Process Started',
        message: `${currentUser.name} has initiated an ownership claim. Member 3 verification is now active.`,
        isRead: false,
        createdAt: nowStr,
      });
    } else if (status === 'CLOSED') {
      actionType = 'MATCH_CLOSED';
      if (!note) note = `Match closed by ${currentUser.name}.`;
    }

    const auditEntry: MatchAuditEntry = {
      actorId: userId,
      actorName: currentUser.name,
      actorRole: userRole,
      action: actionType,
      previousStatus: currentStatus,
      newStatus: status,
      timestamp: new Date().toISOString(),
      note,
    };

    const updatedMatch = await updateMatchStatus(match._id, status, auditEntry, extraFields);

    const populated = updatedMatch ? await populateMatch(updatedMatch, userId, userRole) : null;
    res.json({
      success: true,
      message: `Match status updated to ${status}.`,
      match: populated,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Recalculate all matches on demand
app.post('/api/matches/recalculate', requireAuth, async (_req: Request, res: Response) => {
  try {
    const count = await recalculateAllMatches();
    const total = await getAllMatchesCount();
    res.json({
      success: true,
      message: `Smart matching finished. Active matches processed: ${count}.`,
      processedCount: count,
      totalMatches: total,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== MEMBER 2: NOTIFICATIONS APIS ====================

app.get('/api/notifications', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.currentUser!._id;
    const notifs = await findNotificationsForUser(userId);

    res.json({
      success: true,
      count: notifs.length,
      notifications: notifs,
    });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/notifications/unread-count', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.currentUser!._id;
    const unread = await getUnreadNotificationCount(userId);
    res.json({ success: true, count: unread });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.currentUser!._id;
    const success = await markNotificationRead(req.params.id, userId);
    if (!success) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/notifications/mark-all-read', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.currentUser!._id;
    const count = await markAllNotificationsRead(userId);
    res.json({ success: true, message: `Marked ${count} notifications as read.` });
  } catch (err: any) {
    if (err instanceof DatabaseDisconnectedError) {
      return res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Transaction diagnostics and outbox management
app.get('/api/system/transaction-status', async (_req: Request, res: Response) => {
  try {
    const isAtlas = isAtlasConnected();
    const txSupport = await checkTransactionSupport();
    const activeLocks = getActiveRecoveryLocksCount();
    res.json({
      success: true,
      isAtlas,
      transactionSupport: txSupport,
      activeRecoveryLocks: activeLocks,
      storageMode: isAtlas && txSupport.supported ? 'MongoDB Atlas Replica Set (Multi-Document Transactions)' : 'Dual-Mode Snapshot Isolation with Explicit Rollback',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/notifications/outbox', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const outbox = await getAllOutboxNotifications();
    res.json({ success: true, count: outbox.length, outbox });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/notifications/status', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const allOutbox = await getAllOutboxNotifications();
    const summary = {
      total: allOutbox.length,
      pending: allOutbox.filter(r => r.status === 'PENDING').length,
      retrying: allOutbox.filter(r => r.status === 'RETRYING').length,
      sent: allOutbox.filter(r => r.status === 'SENT' || (r.status as any) === 'PROCESSED').length,
      failed: allOutbox.filter(r => r.status === 'FAILED').length,
    };
    res.json({
      success: true,
      summary,
      workerRunning: getIsRetryWorkerRunning(),
      maxRetryAttempts: MAX_RETRY_ATTEMPTS,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/notifications/retry', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const forceAll = req.body?.forceAll !== false;
    const result = await processNotificationRetries({ forceAll });
    res.json({
      success: true,
      message: `Processed ${result.processed} notifications: ${result.succeeded} succeeded, ${result.failedPermanently} failed, ${result.stillRetrying} still retrying.`,
      result,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/notifications/outbox/retry', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await retryFailedOutboxNotifications();
    res.json({ success: true, message: `Retried ${result.retried} outbox notifications (${result.succeeded} succeeded).`, result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== FRONTEND STATIC SERVING ====================

const frontendDir = path.resolve(__dirname, 'frontend');

app.use(express.static(frontendDir));

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

const htmlPages = [
  'dashboard',
  'find-items',
  'view-matches',
  'my-reports',
  'report-lost',
  'report-found',
  'login',
  'register',
];

for (const page of htmlPages) {
  app.get(`/${page}`, (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDir, `${page}.html`));
  });
}

app.all('/api/*', (_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'API route not found.' });
});

app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// ==================== BOOTSTRAP SERVER ====================

async function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`ReClaim - Find Your Belongings (Member 2 Active)`);
    console.log(`Server running at http://0.0.0.0:${PORT}`);
    console.log(`Database Target: ${DB_NAME}`);
    console.log(`Demo Data Auto-Insertion: DISABLED for clean production`);
    console.log(`=======================================================`);
  });

  // Attempt real MongoDB Atlas connection on startup
  await initDatabase();

  // Background retry worker for resilient notification delivery (every 30 seconds)
  setInterval(async () => {
    try {
      await processNotificationRetries();
    } catch (err: any) {
      console.warn('[Notification Retry Worker Notice]:', err?.message);
    }
  }, 30000);
}

startServer().catch(err => {
  console.error('Fatal server boot error:', err);
  process.exit(1);
});
