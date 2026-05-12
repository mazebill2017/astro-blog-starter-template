import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';

type Bindings = {
  DB: D1Database;
  API_KEY: string;
};

type Variables = {
  user: { id: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware: CORS + Auth
app.use('*', cors());
app.use('/api/*', async (c, next) => {
  const auth = bearerAuth({ token: c.env.API_KEY });
  return auth(c, next);
});

// ============================================
// 🔐 AUTH & SETTINGS
// ============================================

// Login admin
app.post('/api/auth/admin', async (c) => {
  try {
    const { password } = await c.req.json();
    const result = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'admin_pwd'"
    ).first<{ value: string }>();
    
    if (result?.value === password) {
      return c.json({ success: true });
    }
    return c.json({ success: false, error: 'Password salah' }, 401);
  } catch (e) {
    return c.json({ error: 'Server error' }, 500);
  }
});

// Ganti password admin
app.post('/api/auth/change-password', async (c) => {
  try {
    const { newPassword } = await c.req.json();
    if (!newPassword || newPassword.length < 4) {
      return c.json({ error: 'Password minimal 4 karakter' }, 400);
    }
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin_pwd', ?, strftime('%s', 'now'))"
    ).bind(newPassword).run();
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: 'Gagal update password' }, 500);
  }
});

// ============================================
// 📦 PRODUCTS CRUD
// ============================================

// Get semua produk (dengan filter & pagination)
app.get('/api/products', async (c) => {
  try {
    const { search, kategori, minStock, page = 1, limit = 100 } = c.req.query();
    
    let query = `
      SELECT id, barcode, name, kategori, harga, stock, created_at, updated_at 
      FROM products WHERE 1=1
    `;
    const params: any[] = [];
    
    if (search) {
      query += ` AND (LOWER(name) LIKE ? OR LOWER(id) LIKE ? OR barcode LIKE ?)`;
      const s = `%${search.toLowerCase()}%`;
      params.push(s, s, search);
    }
    if (kategori) {
      query += ` AND kategori = ?`;
      params.push(kategori);
    }
    if (minStock !== undefined) {
      query += ` AND stock <= ?`;
      params.push(parseInt(minStock));
    }
    
    query += ` ORDER BY name LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM products WHERE 1=1${search ? ' AND (LOWER(name) LIKE ? OR LOWER(id) LIKE ? OR barcode LIKE ?)' : ''}`
    ).bind(...(search ? [`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`, search] : [])).first<{ total: number }>();
    
    return c.json({ 
      success: true, 
      data: results, 
      pagination: { page: parseInt(page), limit: parseInt(limit), total: count?.total || 0 }
    });
  } catch (e) {
    return c.json({ error: 'Gagal mengambil produk', details: (e as Error).message }, 500);
  }
});

// Get produk by ID / barcode / kode
app.get('/api/products/:identifier', async (c) => {
  try {
    const id = c.req.param('identifier');
    const product = await c.env.DB.prepare(`
      SELECT * FROM products WHERE id = ? OR barcode = ? OR LOWER(id) = ?
    `).bind(id, id, id.toLowerCase()).first();
    
    if (!product) return c.json({ error: 'Produk tidak ditemukan' }, 404);
    return c.json({ success: true, data: product });
  } catch (e) {
    return c.json({ error: 'Gagal mengambil produk' }, 500);
  }
});

// Create / Update produk (UPSERT)
app.post('/api/products', async (c) => {
  try {
    const data = await c.req.json();
    const { id, barcode, name, kategori, harga, stock } = data;
    
    if (!id || !name || harga === undefined) {
      return c.json({ error: 'Kode, nama, dan harga wajib diisi' }, 400);
    }
    
    await c.env.DB.prepare(`
      INSERT INTO products (id, barcode, name, kategori, harga, stock, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET 
        barcode = excluded.barcode,
        name = excluded.name,
        kategori = excluded.kategori,
        harga = excluded.harga,
        stock = excluded.stock,
        updated_at = strftime('%s', 'now')
    `).bind(id, barcode || null, name, kategori || null, harga, stock || 0).run();
    
    return c.json({ success: true, data: { id, name } });
  } catch (e) {
    return c.json({ error: 'Gagal menyimpan produk', details: (e as Error).message }, 500);
  }
});

// Delete produk
app.delete('/api/products/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: 'Gagal menghapus produk' }, 500);
  }
});

// Bulk import produk
app.post('/api/products/bulk', async (c) => {
  try {
    const { products } = await c.req.json();
    if (!Array.isArray(products) || products.length === 0) {
      return c.json({ error: 'Data produk harus array tidak kosong' }, 400);
    }
    
    const stmt = c.env.DB.prepare(`
      INSERT INTO products (id, barcode, name, kategori, harga, stock, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(id) DO UPDATE SET 
        barcode = excluded.barcode, name = excluded.name,
        kategori = excluded.kategori, harga = excluded.harga,
        stock = excluded.stock, updated_at = strftime('%s', 'now')
    `);
    
    const batch = products.map(p => 
      stmt.bind(p.id, p.barcode || null, p.name, p.kategori || null, p.harga, p.stock || 0)
    );
    
    await c.env.DB.batch(batch);
    return c.json({ success: true, imported: products.length });
  } catch (e) {
    return c.json({ error: 'Gagal import bulk', details: (e as Error).message }, 500);
  }
});

// Update stok produk
app.patch('/api/products/:id/stock', async (c) => {
  try {
    const { stock } = await c.req.json();
    const id = c.req.param('id');
    
    await c.env.DB.prepare(`
      UPDATE products SET stock = ?, updated_at = strftime('%s', 'now') WHERE id = ?
    `).bind(Math.max(0, stock), id).run();
    
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: 'Gagal update stok' }, 500);
  }
});

// ============================================
// 👤 KASIR CRUD
// ============================================

app.get('/api/kasir', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, nama, status, created_at FROM kasir ORDER BY nama'
    ).all();
    return c.json({ success: true, data: results });
  } catch (e) {
    return c.json({ error: 'Gagal mengambil data kasir' }, 500);
  }
});

app.post('/api/kasir', async (c) => {
  try {
    const { nama, pin, status = 'aktif' } = await c.req.json();
    if (!nama || !/^\d{4}$/.test(pin)) {
      return c.json({ error: 'Nama wajib, PIN harus 4 digit angka' }, 400);
    }
    
    await c.env.DB.prepare(`
      INSERT INTO kasir (nama, pin, status) VALUES (?, ?, ?)
      ON CONFLICT(nama) DO UPDATE SET pin = excluded.pin, status = excluded.status
    `).bind(nama, pin, status).run();
    
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: 'Gagal menyimpan kasir' }, 500);
  }
});

app.delete('/api/kasir/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    // Jangan hapus admin default
    const kasir = await c.env.DB.prepare('SELECT nama FROM kasir WHERE id = ?').bind(id).first<{ nama: string }>();
    if (kasir?.nama === 'Admin') {
      return c.json({ error: 'Admin default tidak bisa dihapus' }, 400);
    }
    await c.env.DB.prepare('DELETE FROM kasir WHERE id = ?').bind(id).run();
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: 'Gagal menghapus kasir' }, 500);
  }
});

// ============================================
// 🧾 TRANSAKSI
// ============================================

// Create transaksi baru
app.post('/api/transactions', async (c) => {
  try {
    const { no_trans, tgl, kasir, pelanggan, items, subtotal, diskon, pajak, total, bayar, metode, detail } = await c.req.json();
    
    if (!no_trans || !items?.length) {
      return c.json({ error: 'No transaksi dan items wajib' }, 400);
    }
    
    // Mulai transaction (D1 batch untuk atomicity)
    const batch: D1PreparedStatement[] = [];
    
    // Insert header transaksi
    batch.push(c.env.DB.prepare(`
      INSERT INTO transactions (no_trans, tgl, kasir, pelanggan, subtotal, diskon, pajak, total, bayar, metode, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(no_trans, tgl, kasir, pelanggan || 'Umum', subtotal, diskon || 0, pajak || 0, total, bayar, metode, detail));
    
    // Insert items & update stok
    for (const item of items) {
      batch.push(c.env.DB.prepare(`
        INSERT INTO transaction_items (no_trans, product_id, product_name, qty, harga, pot, total)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(no_trans, item.id, item.name, item.qty, item.harga, item.pot || 0, (item.harga - (item.pot || 0)) * item.qty));
      
      // Kurangi stok
      batch.push(c.env.DB.prepare(`
        UPDATE products SET stock = stock - ?, updated_at = strftime('%s', 'now') WHERE id = ? AND stock >= ?
      `).bind(item.qty, item.id, item.qty));
    }
    
    // Update counter transaksi
    batch.push(c.env.DB.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at) 
      SELECT 'trx_counter', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'trx_counter'), 0) + 1 AS TEXT), strftime('%s', 'now')
    `));
    
    await c.env.DB.batch(batch);
    
    return c.json({ success: true, no_trans });
  } catch (e) {
    return c.json({ error: 'Gagal simpan transaksi', details: (e as Error).message }, 500);
  }
});

// Get riwayat transaksi
app.get('/api/transactions', async (c) => {
  try {
    const { page = 1, limit = 20, kasir, from, to } = c.req.query();
    
    let query = `
      SELECT t.*, COUNT(ti.id) as item_count 
      FROM transactions t 
      LEFT JOIN transaction_items ti ON t.no_trans = ti.no_trans 
      WHERE 1=1
    `;
    const params: any[] = [];
    
    if (kasir) { query += ` AND t.kasir = ?`; params.push(kasir); }
    if (from) { query += ` AND t.tgl >= ?`; params.push(from); }
    if (to) { query += ` AND t.tgl <= ?`; params.push(to); }
    
    query += ` GROUP BY t.no_trans ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    
    return c.json({ success: true, data: results });
  } catch (e) {
    return c.json({ error: 'Gagal mengambil riwayat' }, 500);
  }
});

// Get detail transaksi
app.get('/api/transactions/:no_trans', async (c) => {
  try {
    const no_trans = c.req.param('no_trans');
    
    const [header, items] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM transactions WHERE no_trans = ?').bind(no_trans).first(),
      c.env.DB.prepare('SELECT * FROM transaction_items WHERE no_trans = ?').bind(no_trans).all()
    ]);
    
    if (!header) return c.json({ error: 'Transaksi tidak ditemukan' }, 404);
    
    return c.json({ success: true, data: { ...header, items: items.results } });
  } catch (e) {
    return c.json({ error: 'Gagal mengambil detail transaksi' }, 500);
  }
});

// ============================================
// 📊 REPORT & STATS
// ============================================

app.get('/api/stats', async (c) => {
  try {
    const [products, lowStock, totalStok, nilaiInv, oos, todaySales] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as total FROM products').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as total FROM products WHERE stock <= 20').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COALESCE(SUM(stock), 0) as total FROM products').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COALESCE(SUM(harga * stock), 0) as total FROM products').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as total FROM products WHERE stock = 0').first<{ total: number }>(),
      c.env.DB.prepare(`
        SELECT COALESCE(SUM(total), 0) as total 
        FROM transactions 
        WHERE DATE(tgl) = DATE('now', 'localtime')
      `).first<{ total: number }>()
    ]);
    
    return c.json({
      success: true,
      data: {
        totalProduk: products?.total || 0,
        stokRendah: lowStock?.total || 0,
        totalUnit: totalStok?.total || 0,
        nilaiInventori: nilaiInv?.total || 0,
        stokHabis: oos?.total || 0,
        penjualanHariIni: todaySales?.total || 0
      }
    });
  } catch (e) {
    return c.json({ error: 'Gagal mengambil stats' }, 500);
  }
});

// ============================================
// 🔄 SYNC & UTILS
// ============================================

// Sync counter transaksi ke localStorage (untuk fallback)
app.get('/api/sync/counter', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'trx_counter'"
    ).first<{ value: string }>();
    return c.json({ success: true, counter: parseInt(result?.value || '0') });
  } catch (e) {
    return c.json({ error: 'Gagal sync counter' }, 500);
  }
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

export default app;
