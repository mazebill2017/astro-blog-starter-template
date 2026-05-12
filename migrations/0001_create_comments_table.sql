-- migrations/0001_initial_schema.sql
-- POS Supermarket Database Schema v1.0

-- ============================================
-- Tabel Products
-- ============================================
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    barcode TEXT UNIQUE,
    name TEXT NOT NULL,
    kategori TEXT,
    harga INTEGER NOT NULL DEFAULT 0 CHECK(harga >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- Tabel Kasir
-- ============================================
CREATE TABLE IF NOT EXISTS kasir (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL UNIQUE,
    pin TEXT NOT NULL CHECK(length(pin) = 4),
    status TEXT DEFAULT 'aktif' CHECK(status IN ('aktif', 'nonaktif')),
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- Tabel Transactions (Header)
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    no_trans TEXT PRIMARY KEY,
    tgl TEXT NOT NULL,
    kasir TEXT NOT NULL,
    pelanggan TEXT DEFAULT 'Umum',
    subtotal INTEGER NOT NULL DEFAULT 0,
    diskon INTEGER DEFAULT 0,
    pajak INTEGER DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    bayar INTEGER NOT NULL DEFAULT 0,
    metode TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (kasir) REFERENCES kasir(nama) ON UPDATE CASCADE
);

-- ============================================
-- Tabel Transaction Items
-- ============================================
CREATE TABLE IF NOT EXISTS transaction_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    no_trans TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1 CHECK(qty > 0),
    harga INTEGER NOT NULL,
    pot INTEGER DEFAULT 0,
    total INTEGER NOT NULL,
    FOREIGN KEY (no_trans) REFERENCES transactions(no_trans) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE
);

-- ============================================
-- Tabel Settings
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- Indexes untuk Optimasi
-- ============================================
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_kategori ON products(kategori);
CREATE INDEX IF NOT EXISTS idx_products_stock_low ON products(stock) WHERE stock <= 20;
CREATE INDEX IF NOT EXISTS idx_products_search ON products(name, kategori);

CREATE INDEX IF NOT EXISTS idx_transactions_tgl ON transactions(tgl);
CREATE INDEX IF NOT EXISTS idx_transactions_kasir ON transactions(kasir);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);

CREATE INDEX IF NOT EXISTS idx_items_no_trans ON transaction_items(no_trans);
CREATE INDEX IF NOT EXISTS idx_items_product ON transaction_items(product_id);

-- ============================================
-- Seed Data Default
-- ============================================

-- Settings default
INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('admin_pwd', 'admin123'),
    ('trx_counter', '0'),
    ('app_version', '1.0.0');

-- Kasir default
INSERT OR IGNORE INTO kasir (id, nama, pin, status) VALUES 
    (1, 'Admin', '1234', 'aktif'),
    (2, 'Siti Rahayu', '5678', 'aktif'),
    (3, 'Budi Hartono', '9012', 'aktif'),
    (4, 'Dewi Lestari', '3456', 'nonaktif');

-- Produk contoh (sesuaikan dengan data riil)
INSERT OR IGNORE INTO products (id, barcode, name, kategori, harga, stock) VALUES 
    ('A2728', '8992770011169', 'AJI-NO-MOTO 180G', 'BUMBU', 5300, 150),
    ('A0423', '8992770011091', 'AJI-NO-MOTO 250G', 'BUMBU', 7600, 80),
    ('10001', '8992753282401', '123 BENDERA COKLAT 300G', 'SUSU', 19600, 45),
    ('20020', '8999909192034', '2.3.4 FILTER', 'ROKOK', 86000, 30),
    ('A2599', '711844110717', 'ABC KECAP PEDAS 275ML', 'SAUCE', 10500, 60),
    ('A2568', '8992761111212', 'A&W SARSAPARILA 330ML', 'MINUMAN', 5000, 120),
    ('A0910', '8992727000314', 'ATTACK 900G CLEAN MAX', 'DETERGEN', 14900, 55),
    ('C3727', '6926763600353', 'CASIO FX 82MS', 'STATIONERY', 112000, 15),
    ('O0425', '4893049130007', 'OREO 170G DOUBLESTUF', 'BISKUIT', 6200, 100),
    ('S0768', '089686017076', 'SARIMI 5S AYAM BWG', 'MIE', 7600, 200);
