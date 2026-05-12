// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';

type Bindings = {
  DB: D1Database;
  API_KEY: string;
  API_VERSION: string;
  ENVIRONMENT: string;
};

type Variables = {
  authenticated: boolean;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ============================================
// 🛡️ MIDDLEWARE
// ============================================

// CORS untuk semua route
app.use('*', cors({
  origin: ['*', 'http://localhost:*', 'https://*.pages.dev'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}));

// Auth middleware untuk API routes
app.use('/api/*', async (c, next) => {
  // Skip auth untuk health check dan public endpoints
  if (c.req.path === '/api/health' || c.req.path === '/api/products/search') {
    return next();
  }
  
  const authHeader = c.req.header('Authorization');
  const expectedKey = c.env.API_KEY;
  
  if (!expectedKey) {
    console.warn('⚠️ API_KEY not configured in environment');
    return next(); // Allow in dev mode
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }
  
  const token = authHeader.slice(7);
  if (token !== expectedKey) {
    throw new HTTPException(401, { message: 'Invalid API key' });
  }
  
  c.set('authenticated', true);
  return next();
});

// Error handler global
app.onError((err, c) => {
  console.error('❌ Error:', err);
  
  if (err instanceof HTTPException) {
    return c.json({ 
      success: false, 
      error: err.message,
      code: err.status 
    }, err.status);
  }
  
  return c.json({ 
    success: false, 
    error: 'Internal server error',
    details: c.env.ENVIRONMENT === 'development' ? err.message : undefined
  }, 500);
});

// Not found handler
app.notFound((c) => c.json({ success: false, error: 'Endpoint not found' }, 404));

// ============================================
// 🏥 HEALTH & UTILS
// ============================================

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: c.env.API_VERSION,
    environment: c.env.ENVIRONMENT,
    database: 'connected'
  });
});

app.get('/', (c) => {
  return c.json({
    name: 'POS Supermarket API',
    version: c.env.API_VERSION,
    endpoints: {
      products: '/api/products',
      kasir: '/api/kasir',
      transactions: '/api/transactions',
      stats: '/api/stats',
      auth: '/api/auth'
    },
    docs: 'https://github.com/your-repo/pos-supermarket'
  });
});

// ============================================
// 🔐 AUTH
// ============================================

// Login admin
app.post('/api/auth/admin', async (c) => {
  try {
    const { password } = await c.req.json();
    
    if (!password) {
      return c.json({ success: false, error: 'Password required' }, 400);
    }
    
    const result = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'admin_pwd'"
    ).first<{ value: string }>();
    
    // Default password fallback for first setup
    const storedPwd = result?.value || 'admin123';
    
    if (password === storedPwd) {
      return c.json({ 
        success: true, 
        message: 'Login successful',
        token: btoa(JSON.stringify({ admin: true, exp: Date.now() + 86400000 }))
      });
    }
    
    return c.json({ success: false, error: 'Password salah' }, 401);
  } catch (error) {
    console.error('Auth error:', error);
    return c.json({ success: false, error: 'Authentication failed' }, 500);
  }
});

// Change admin password
app.post('/api/auth/change-password', async (c) => {
  try {
    const { newPassword, currentPassword } = await c.req.json();
    
    if (!newPassword || newPassword.length < 4) {
      return c.json({ success: false, error: 'Password minimal 4 karakter' }, 400);
    }
    
    // Verify current password first
    if (currentPassword) {
      const result = await c.env.DB.prepare(
        "SELECT value FROM settings WHERE key = 'admin_pwd'"
      ).first<{ value: string }>();
      
      const storedPwd = result?.value || 'admin123';
      if (currentPassword !== storedPwd) {
        return c.json({ success: false, error: 'Password lama salah' }, 401);
      }
    }
    
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin_pwd', ?, strftime('%s', 'now'))"
    ).bind(newPassword).run();
    
    return c.json({ success: true, message: 'Password berhasil diubah' });
  } catch (error) {
    console.error('Change password error:', error);
    return c.json({ success: false, error: 'Gagal update password' }, 500);
  }
});

// ============================================
// 📦 PRODUCTS API
// ============================================

// Get all products with filters & pagination
app.get('/api/products', async (c) => {
  try {
    const { 
      search, 
      kategori, 
      minStock, 
      maxStock,
      page = 1, 
      limit = 100,
      sortBy = 'name',
      sortOrder = 'ASC'
    } = c.req.query();
    
    let query = `
      SELECT id, barcode, name, kategori, harga, stock, created_at, updated_at 
      FROM products WHERE 1=1
    `;
    const params: any[] = [];
    
    // Search filter
    if (search) {
      query += ` AND (LOWER(name) LIKE ? OR LOWER(id) LIKE ? OR barcode LIKE ?)`;
      const s = `%${search.toLowerCase()}%`;
      params.push(s, s, search);
    }
    
    // Category filter
    if (kategori) {
      query += ` AND LOWER(kategori) = LOWER(?)`;
      params.push(kategori);
    }
    
    // Stock filters
    if (minStock !== undefined) {
      query += ` AND stock >= ?`;
      params.push(parseInt(minStock));
    }
    if (maxStock !== undefined) {
      query += ` AND stock <= ?`;
      params.push(parseInt(maxStock));
    }
    
    // Sorting
    const validSorts = ['name', 'harga', 'stock', 'created_at', 'updated_at'];
    const sortField = validSorts.includes(sortBy) ? sortBy : 'name';
    const order = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    query += ` ORDER BY ${sortField} ${order}`;
    
    // Pagination
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(500, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;
    
    query += ` LIMIT ? OFFSET ?`;
    params.push(limitNum, offset);
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    
    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM products WHERE 1=1`;
    const countParams: any[] = [];
    
    if (search) {
      countQuery += ` AND (LOWER(name) LIKE ? OR LOWER(id) LIKE ? OR barcode LIKE ?)`;
      const s = `%${search.toLowerCase()}%`;
      countParams.push(s, s, search);
    }
    if (kategori) {
      countQuery += ` AND LOWER(kategori) = LOWER(?)`;
      countParams.push(kategori);
    }
    if (minStock !== undefined) {
      countQuery += ` AND stock >= ?`;
      countParams.push(parseInt(minStock));
    }
    if (maxStock !== undefined) {
      countQuery += ` AND stock <= ?`;
      countParams.push(parseInt(maxStock));
    }
    
    const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>();
    
    return c.json({ 
      success: true, 
      data: results || [],
      pagination: { 
        page: pageNum, 
        limit: limitNum, 
        total: countResult?.total || 0,
        totalPages: Math.ceil((countResult?.total || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    return c.json({ success: false, error: 'Gagal mengambil produk', details: (error as Error).message }, 500);
  }
});

// Quick search for autocomplete (public endpoint)
app.get('/api/products/search', async (c) => {
  try {
    const q = c.req.query('q')?.trim();
    if (!q || q.length < 2) {
      return c.json({ success: true, data: [] });
    }
    
    const searchLower = q.toLowerCase();
    
    // Try exact match first (kode or barcode)
    const exact = await c.env.DB.prepare(`
      SELECT id, barcode, name, kategori, harga, stock 
      FROM products 
      WHERE id = ? OR barcode = ? OR LOWER(id) = ?
      LIMIT 1
    `).bind(q, q, searchLower).first();
    
    if (exact) {
      return c.json({ success: true, data: [exact], exactMatch: true });
    }
    
    // Fuzzy search
    const { results } = await c.env.DB.prepare(`
      SELECT id, barcode, name, kategori, harga, stock
      FROM products 
      WHERE LOWER(name) LIKE ? 
         OR LOWER(kategori) LIKE ?
         OR barcode LIKE ?
      ORDER BY 
        CASE 
          WHEN LOWER(name) LIKE ? THEN 1
          WHEN LOWER(name) LIKE ? THEN 2
          ELSE 3
        END,
        stock DESC
      LIMIT 20
    `).bind(
      `%${searchLower}%`, 
      `%${searchLower}%`, 
      `%${q}%`,
      `${searchLower}%`,  // Starts with - higher priority
      `%${searchLower}%`  // Contains
    ).all();
    
    return c.json({ success: true, data: results || [], exactMatch: false });
  } catch (error) {
    console.error('Search error:', error);
    return c.json({ success: false, error: 'Search failed' }, 500);
  }
});

// Get single product by ID/barcode
app.get('/api/products/:identifier', async (c) => {
  try {
    const identifier = c.req.param('identifier');
    
    const product = await c.env.DB.prepare(`
      SELECT id, barcode, name, kategori, harga, stock, created_at, updated_at
      FROM products 
      WHERE id = ? OR barcode = ? OR LOWER(id) = ?
      LIMIT 1
    `).bind(identifier, identifier, identifier.toLowerCase()).first();
    
    if (!product) {
      return c.json({ success: false, error: 'Produk tidak ditemukan', code: 'NOT_FOUND' }, 404);
    }
    
    return c.json({ success: true, data: product });
  } catch (error) {
    console.error('Get product error:', error);
    return c.json({ success: false, error: 'Gagal mengambil produk' }, 500);
  }
});

// Create or update product (UPSERT)
app.post('/api/products', async (c) => {
  try {
    const data = await c.req.json();
    const { id, barcode, name, kategori, harga, stock } = data;
    
    // Validation
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return c.json({ success: false, error: 'Kode produk wajib diisi' }, 400);
    }
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return c.json({ success: false, error: 'Nama produk wajib diisi' }, 400);
    }
    if (harga === undefined || isNaN(Number(harga)) || Number(harga) < 0) {
      return c.json({ success: false, error: 'Harga harus angka positif' }, 400);
    }
    
    const cleanId = id.trim().toUpperCase();
    const cleanBarcode = barcode?.toString().trim() || null;
    const cleanName = name.trim();
    const cleanKategori = kategori?.toString().trim() || null;
    const cleanHarga = Math.round(Number(harga));
    const cleanStock = Math.max(0, Math.round(Number(stock) || 0));
    
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
    `).bind(cleanId, cleanBarcode, cleanName, cleanKategori, cleanHarga, cleanStock).run();
    
    return c.json({ 
      success: true, 
      message: cleanBarcode ? 'Produk diperbarui' : 'Produk ditambahkan',
      data: { id: cleanId, name: cleanName }
    });
  } catch (error: any) {
    console.error('Save product error:', error);
    
    // Handle unique constraint violations
    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.json({ success: false, error: 'Kode atau barcode sudah terdaftar' }, 409);
    }
    
    return c.json({ success: false, error: 'Gagal menyimpan produk', details: error.message }, 500);
  }
});

// Bulk import products
app.post('/api/products/bulk', async (c) => {
  try {
    const { products: productList } = await c.req.json();
    
    if (!Array.isArray(productList) || productList.length === 0) {
      return c.json({ success: false, error: 'Data produk harus array tidak kosong' }, 400);
    }
    
    // Limit batch size for D1
    const batchSize = 100;
    const results = { added: 0, updated: 0, errors: [] };
    
    for (let i = 0; i < productList.length; i += batchSize) {
      const batch = productList.slice(i, i + batchSize);
      const statements: D1PreparedStatement[] = [];
      
      for (const p of batch) {
        if (!p.id || !p.name || p.harga === undefined) {
          results.errors.push({ index: i + batch.indexOf(p), error: 'Missing required fields' });
          continue;
        }
        
        statements.push(
          c.env.DB.prepare(`
            INSERT INTO products (id, barcode, name, kategori, harga, stock, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
            ON CONFLICT(id) DO UPDATE SET 
              barcode = excluded.barcode, name = excluded.name,
              kategori = excluded.kategori, harga = excluded.harga,
              stock = excluded.stock, updated_at = strftime('%s', 'now')
          `).bind(
            String(p.id).trim().toUpperCase(),
            p.barcode?.toString().trim() || null,
            String(p.name).trim(),
            p.kategori?.toString().trim() || null,
            Math.round(Number(p.harga)),
            Math.max(0, Math.round(Number(p.stock) || 0))
          )
        );
      }
      
      if (statements.length > 0) {
        const batchResult = await c.env.DB.batch<any>(statements);
        
        // Count added vs updated (simplified - D1 doesn't return this directly)
        results.added += statements.length; // Approximation
      }
    }
    
    return c.json({ 
      success: true, 
      message: `Import selesai: ${results.added} produk diproses`,
      summary: results
    });
  } catch (error: any) {
    console.error('Bulk import error:', error);
    return c.json({ success: false, error: 'Gagal import bulk', details: error.message }, 500);
  }
});

// Update stock only
app.patch('/api/products/:id/stock', async (c) => {
  try {
    const id = c.req.param('id');
    const { stock, operation = 'set' } = await c.req.json();
    
    if (stock === undefined || isNaN(Number(stock))) {
      return c.json({ success: false, error: 'Stok harus angka' }, 400);
    }
    
    let newStock: number;
    if (operation === 'add') {
      // Get current stock first
      const current = await c.env.DB.prepare('SELECT stock FROM products WHERE id = ?')
        .bind(id).first<{ stock: number }>();
      if (!current) {
        return c.json({ success: false, error: 'Produk tidak ditemukan' }, 404);
      }
      newStock = Math.max(0, current.stock + Number(stock));
    } else if (operation === 'subtract') {
      const current = await c.env.DB.prepare('SELECT stock FROM products WHERE id = ?')
        .bind(id).first<{ stock: number }>();
      if (!current) {
        return c.json({ success: false, error: 'Produk tidak ditemukan' }, 404);
      }
      newStock = Math.max(0, current.stock - Number(stock));
    } else {
      newStock = Math.max(0, Number(stock));
    }
    
    const result = await c.env.DB.prepare(`
      UPDATE products 
      SET stock = ?, updated_at = strftime('%s', 'now') 
      WHERE id = ?
    `).bind(newStock, id).run();
    
    if (!result.success || result.meta?.changes === 0) {
      return c.json({ success: false, error: 'Produk tidak ditemukan atau tidak ada perubahan' }, 404);
    }
    
    return c.json({ success: true, data: { id, stock: newStock } });
  } catch (error) {
    console.error('Update stock error:', error);
    return c.json({ success: false, error: 'Gagal update stok' }, 500);
  }
});

// Delete product
app.delete('/api/products/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    // Check if product has transactions (prevent deletion)
    const hasTransactions = await c.env.DB.prepare(`
      SELECT 1 FROM transaction_items WHERE product_id = ? LIMIT 1
    `).bind(id).first();
    
    if (hasTransactions) {
      return c.json({ 
        success: false, 
        error: 'Produk tidak bisa dihapus karena sudah ada dalam transaksi',
        code: 'HAS_TRANSACTIONS'
      }, 409);
    }
    
    const result = await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
    
    if (!result.success || result.meta?.changes === 0) {
      return c.json({ success: false, error: 'Produk tidak ditemukan' }, 404);
    }
    
    return c.json({ success: true, message: 'Produk dihapus' });
  } catch (error) {
    console.error('Delete product error:', error);
    return c.json({ success: false, error: 'Gagal menghapus produk' }, 500);
  }
});

// Get unique categories
app.get('/api/products/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT DISTINCT kategori FROM products 
      WHERE kategori IS NOT NULL AND kategori != ''
      ORDER BY kategori
    `).all();
    
    return c.json({ 
      success: true, 
      data: (results || []).map(r => r.kategori).filter(Boolean)
    });
  } catch (error) {
    return c.json({ success: false, error: 'Gagal mengambil kategori' }, 500);
  }
});

// ============================================
// 👤 KASIR API
// ============================================

app.get('/api/kasir', async (c) => {
  try {
    const { status } = c.req.query();
    
    let query = 'SELECT id, nama, status, created_at FROM kasir WHERE 1=1';
    const params: any[] = [];
    
    if (status === 'aktif' || status === 'nonaktif') {
      query += ' AND status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY nama';
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    
    return c.json({ success: true, data: results || [] });
  } catch (error) {
    console.error('Get kasir error:', error);
    return c.json({ success: false, error: 'Gagal mengambil data kasir' }, 500);
  }
});

app.post('/api/kasir', async (c) => {
  try {
    const { nama, pin, status = 'aktif' } = await c.req.json();
    
    if (!nama || typeof nama !== 'string' || nama.trim() === '') {
      return c.json({ success: false, error: 'Nama kasir wajib diisi' }, 400);
    }
    if (!pin || !/^\d{4}$/.test(String(pin))) {
      return c.json({ success: false, error: 'PIN harus 4 digit angka' }, 400);
    }
    if (!['aktif', 'nonaktif'].includes(status)) {
      return c.json({ success: false, error: 'Status tidak valid' }, 400);
    }
    
    await c.env.DB.prepare(`
      INSERT INTO kasir (nama, pin, status) 
      VALUES (?, ?, ?)
      ON CONFLICT(nama) DO UPDATE SET 
        pin = excluded.pin, 
        status = excluded.status,
        updated_at = strftime('%s', 'now')
    `).bind(nama.trim(), String(pin), status).run();
    
    return c.json({ success: true, message: 'Kasir disimpan' });
  } catch (error: any) {
    console.error('Save kasir error:', error);
    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.json({ success: false, error: 'Nama kasir sudah terdaftar' }, 409);
    }
    return c.json({ success: false, error: 'Gagal menyimpan kasir' }, 500);
  }
});

app.delete('/api/kasir/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    
    // Prevent deleting default admin
    const kasir = await c.env.DB.prepare('SELECT nama FROM kasir WHERE id = ?')
      .bind(id).first<{ nama: string }>();
    
    if (!kasir) {
      return c.json({ success: false, error: 'Kasir tidak ditemukan' }, 404);
    }
    
    if (kasir.nama === 'Admin') {
      return c.json({ success: false, error: 'Admin default tidak bisa dihapus' }, 400);
    }
    
    await c.env.DB.prepare('DELETE FROM kasir WHERE id = ?').bind(id).run();
    
    return c.json({ success: true, message: 'Kasir dihapus' });
  } catch (error) {
    console.error('Delete kasir error:', error);
    return c.json({ success: false, error: 'Gagal menghapus kasir' }, 500);
  }
});

// ============================================
// 🧾 TRANSACTIONS API
// ============================================

// Create new transaction (atomic with stock update)
app.post('/api/transactions', async (c) => {
  try {
    const trx = await c.req.json();
    const { 
      no_trans, tgl, kasir, pelanggan, 
      items, subtotal, diskon, pajak, 
      total, bayar, metode, detail 
    } = trx;
    
    // Validation
    if (!no_trans || !items?.length) {
      return c.json({ success: false, error: 'No transaksi dan items wajib' }, 400);
    }
    if (!Array.isArray(items) || items.some(i => !i.id || !i.qty || i.harga === undefined)) {
      return c.json({ success: false, error: 'Format items tidak valid' }, 400);
    }
    
    // Start transaction batch (D1 batch for atomicity)
    const batch: D1PreparedStatement[] = [];
    
    // 1. Insert transaction header
    batch.push(c.env.DB.prepare(`
      INSERT INTO transactions (
        no_trans, tgl, kasir, pelanggan, 
        subtotal, diskon, pajak, total, bayar, metode, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      no_trans, 
      tgl || new Date().toISOString().split('T')[0],
      kasir, 
      pelanggan || 'Umum', 
      subtotal || 0, 
      diskon || 0, 
      pajak || 0, 
      total, 
      bayar, 
      metode || 'Cash', 
      detail || null
    ));
    
    // 2. Insert items & update stock
    for (const item of items) {
      const itemTotal = (item.harga - (item.pot || 0)) * item.qty;
      
      // Insert transaction item
      batch.push(c.env.DB.prepare(`
        INSERT INTO transaction_items (
          no_trans, product_id, product_name, qty, harga, pot, total
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        no_trans, 
        item.id, 
        item.name, 
        item.qty, 
        item.harga, 
        item.pot || 0, 
        itemTotal
      ));
      
      // Update product stock (with check to prevent negative)
      batch.push(c.env.DB.prepare(`
        UPDATE products 
        SET stock = stock - ?, updated_at = strftime('%s', 'now') 
        WHERE id = ? AND stock >= ?
      `).bind(item.qty, item.id, item.qty));
    }
    
    // 3. Update transaction counter
    batch.push(c.env.DB.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at) 
      SELECT 'trx_counter', 
             CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'trx_counter'), 0) + 1 AS TEXT), 
             strftime('%s', 'now')
    `));
    
    // Execute batch
    const results = await c.env.DB.batch(batch);
    
    // Check for stock update failures
    const stockUpdates = results.slice(2, 2 + items.length * 2).filter((_, i) => i % 2 === 1);
    for (let i = 0; i < stockUpdates.length; i++) {
      if (!stockUpdates[i].success || stockUpdates[i].meta?.changes === 0) {
        // Rollback would be ideal, but D1 batch doesn't support partial rollback
        // Return error and let frontend handle retry
        return c.json({ 
          success: false, 
          error: `Stok tidak cukup untuk: ${items[i].name}`,
          code: 'INSUFFICIENT_STOCK',
          item: items[i]
        }, 409);
      }
    }
    
    return c.json({ success: true, no_trans, message: 'Transaksi berhasil disimpan' });
    
  } catch (error: any) {
    console.error('Save transaction error:', error);
    
    // Handle constraint errors
    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.json({ success: false, error: 'No transaksi sudah ada' }, 409);
    }
    
    return c.json({ success: false, error: 'Gagal menyimpan transaksi', details: error.message }, 500);
  }
});

// Get transaction history with filters
app.get('/api/transactions', async (c) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      kasir, 
      from, 
      to,
      metode,
      search
    } = c.req.query();
    
    let query = `
      SELECT 
        t.no_trans, t.tgl, t.kasir, t.pelanggan,
        t.subtotal, t.diskon, t.pajak, t.total, t.bayar,
        t.metode, t.detail, t.created_at,
        COUNT(ti.id) as item_count
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.no_trans = ti.no_trans
      WHERE 1=1
    `;
    const params: any[] = [];
    
    if (kasir) { query += ' AND t.kasir = ?'; params.push(kasir); }
    if (from) { query += ' AND t.tgl >= ?'; params.push(from); }
    if (to) { query += ' AND t.tgl <= ?'; params.push(to); }
    if (metode) { query += ' AND t.metode = ?'; params.push(metode); }
    if (search) { 
      query += ' AND (t.no_trans LIKE ? OR t.pelanggan LIKE ?)'; 
      const s = `%${search}%`;
      params.push(s, s);
    }
    
    query += ' GROUP BY t.no_trans ORDER BY t.created_at DESC';
    
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;
    
    query += ' LIMIT ? OFFSET ?';
    params.push(limitNum, offset);
    
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    
    // Get total count
    let countQuery = `SELECT COUNT(DISTINCT no_trans) as total FROM transactions WHERE 1=1`;
    const countParams: any[] = [];
    if (kasir) { countQuery += ' AND kasir = ?'; countParams.push(kasir); }
    if (from) { countQuery += ' AND tgl >= ?'; countParams.push(from); }
    if (to) { countQuery += ' AND tgl <= ?'; countParams.push(to); }
    if (metode) { countQuery += ' AND metode = ?'; countParams.push(metode); }
    if (search) { 
      countQuery += ' AND (no_trans LIKE ? OR pelanggan LIKE ?)'; 
      const s = `%${search}%`;
      countParams.push(s, s);
    }
    
    const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>();
    
    return c.json({ 
      success: true, 
      data: results || [],
      pagination: { 
        page: pageNum, 
        limit: limitNum, 
        total: countResult?.total || 0,
        totalPages: Math.ceil((countResult?.total || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    return c.json({ success: false, error: 'Gagal mengambil riwayat' }, 500);
  }
});

// Get single transaction details
app.get('/api/transactions/:no_trans', async (c) => {
  try {
    const no_trans = c.req.param('no_trans');
    
    const [header, items] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM transactions WHERE no_trans = ?')
        .bind(no_trans).first(),
      c.env.DB.prepare('SELECT * FROM transaction_items WHERE no_trans = ? ORDER BY id')
        .bind(no_trans).all()
    ]);
    
    if (!header) {
      return c.json({ success: false, error: 'Transaksi tidak ditemukan' }, 404);
    }
    
    return c.json({ 
      success: true, 
      data: { 
        ...header, 
        items: items.results || [],
        grand_total: header.total
      } 
    });
  } catch (error) {
    console.error('Get transaction details error:', error);
    return c.json({ success: false, error: 'Gagal mengambil detail transaksi' }, 500);
  }
});

// ============================================
// 📊 STATS & REPORTS
// ============================================

app.get('/api/stats', async (c) => {
  try {
    const [
      products, 
      lowStock, 
      totalStok, 
      nilaiInv, 
      oos, 
      todaySales,
      categories
    ] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as total FROM products').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as total FROM products WHERE stock <= 20 AND stock > 0').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COALESCE(SUM(stock), 0) as total FROM products').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COALESCE(SUM(harga * stock), 0) as total FROM products').first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as total FROM products WHERE stock = 0').first<{ total: number }>(),
      c.env.DB.prepare(`
        SELECT COALESCE(SUM(total), 0) as total 
        FROM transactions 
        WHERE DATE(tgl) = DATE('now', 'localtime')
      `).first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(DISTINCT kategori) as total FROM products WHERE kategori IS NOT NULL').first<{ total: number }>()
    ]);
    
    return c.json({
      success: true,
      data: {
        totalProduk: products?.total || 0,
        stokRendah: lowStock?.total || 0,
        totalUnit: totalStok?.total || 0,
        nilaiInventori: nilaiInv?.total || 0,
        stokHabis: oos?.total || 0,
        penjualanHariIni: todaySales?.total || 0,
        totalKategori: categories?.total || 0,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    return c.json({ success: false, error: 'Gagal mengambil statistik' }, 500);
  }
});

// Sales report by date range
app.get('/api/reports/sales', async (c) => {
  try {
    const { from, to, groupBy = 'day' } = c.req.query();
    
    if (!from || !to) {
      return c.json({ success: false, error: 'Parameter from dan to wajib' }, 400);
    }
    
    const groupFormat = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';
    
    const { results } = await c.env.DB.prepare(`
      SELECT 
        strftime(?, tgl) as period,
        COUNT(*) as transaksi,
        COUNT(DISTINCT kasir) as kasir_aktif,
        SUM(total) as revenue,
        SUM(bayar) as pembayaran,
        AVG(total) as avg_transaksi
      FROM transactions
      WHERE DATE(tgl) BETWEEN DATE(?) AND DATE(?)
      GROUP BY period
      ORDER BY period
    `).bind(groupFormat, from, to).all();
    
    return c.json({ success: true, data: results || [], period: { from, to, groupBy } });
  } catch (error) {
    console.error('Sales report error:', error);
    return c.json({ success: false, error: 'Gagal generate laporan' }, 500);
  }
});

// ============================================
// 🔄 SYNC & UTILS
// ============================================

// Sync counter for frontend
app.get('/api/sync/counter', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'trx_counter'"
    ).first<{ value: string }>();
    
    return c.json({ success: true, counter: parseInt(result?.value || '0') });
  } catch (error) {
    return c.json({ success: false, error: 'Gagal sync counter' }, 500);
  }
});

// Export data for backup
app.get('/api/export/all', async (c) => {
  try {
    const [products, kasir, settings] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM products').all(),
      c.env.DB.prepare('SELECT id, nama, status FROM kasir').all(),
      c.env.DB.prepare('SELECT key, value FROM settings').all()
    ]);
    
    return c.json({
      success: true,
      exported_at: new Date().toISOString(),
      data: {
        products: products.results || [],
        kasir: kasir.results || [],
        settings: settings.results?.filter((s: any) => s.key !== 'admin_pwd') || []
      }
    });
  } catch (error) {
    return c.json({ success: false, error: 'Gagal export data' }, 500);
  }
});

export default app;
