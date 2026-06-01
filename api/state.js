// api/state.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // uuid can come from query (GET) or body (POST)
  const uuid = req.query.uuid || (req.body && req.body.uuid);
  if (!uuid) {
    return res.status(400).json({ error: 'Missing uuid' });
  }

  // GET – return stored state
  if (req.method === 'GET') {
    try {
      const raw = await kv.get(`user:${uuid}`);
      const state = raw ? JSON.parse(raw) : null;
      return res.status(200).json(state);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to read state' });
    }
  }

  // POST – save state
  if (req.method === 'POST') {
    const { state: stateObj } = req.body;
    if (!stateObj) {
      return res.status(400).json({ error: 'Missing state in body' });
    }
    try {
      await kv.set(`user:${uuid}`, JSON.stringify(stateObj));
      // Auto-delete after 60 days of inactivity
      await kv.expire(`user:${uuid}`, 60 * 24 * 60 * 60);
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to save state' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}