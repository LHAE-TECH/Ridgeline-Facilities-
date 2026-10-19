import { Router } from 'express';
import { pool } from '../db.js';
import { audit } from '../services/audit.js';
import { getFileForActor, readStoredFile } from '../services/storage.js';
import { actor, requireRole , pid } from '../web/helpers.js';

export const filesRouter = Router();

filesRouter.get('/:id', requireRole('admin', 'ops', 'finance', 'customer', 'contractor'), async (req, res) => {
  const a = actor(req);
  if (!/^[0-9a-f-]{36}$/i.test(pid(req))) return res.status(404).render('error', { status: 404, message: 'File not found' });
  const file = await getFileForActor(pool, a, pid(req));
  const data = await readStoredFile(file.storage_key);
  if (file.purpose === 'compliance' || file.purpose === 'contractor_invoice') {
    await audit(pool, a, { action: 'file.viewed', entityType: 'file', entityId: file.id });
  }
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `${file.mime_type === 'application/pdf' || file.mime_type.startsWith('image/') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(data);
});
