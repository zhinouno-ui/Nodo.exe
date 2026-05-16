-- ============================================================
-- NODO · OPERATIVO — Setup de tablas en Supabase
-- Pegar en SQL Editor de Supabase y ejecutar
-- ============================================================

-- ── 1. OPERADORES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operadores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario         text UNIQUE NOT NULL,
  clave           text NOT NULL,
  nombre          text NOT NULL,
  rol             text NOT NULL DEFAULT 'OPERADOR',
  tipo_operador   text NOT NULL DEFAULT 'OPERADOR',   -- OPERADOR | FRANQUERO | ADMIN
  pc_codigo       text,                               -- NULL si es FRANQUERO (elige al login)
  pcs_disponibles text[] DEFAULT '{}',               -- solo para FRANQUERO
  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Política: la clave anon puede leer operadores activos (necesario para el login cliente)
ALTER TABLE operadores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon puede leer operadores" ON operadores
  FOR SELECT USING (activo = true);

-- ── 2. BILLETERAS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billeteras (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_visible      text NOT NULL,
  tipo                text,                           -- CBU | CVU | ALIAS | etc
  pc_codigo           text NOT NULL,
  activa              boolean NOT NULL DEFAULT true,
  seleccionada_manual boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE billeteras ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon puede leer billeteras" ON billeteras
  FOR SELECT USING (true);
CREATE POLICY "anon puede actualizar billeteras" ON billeteras
  FOR UPDATE USING (true);

-- ── 3. CHATS (sesiones) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario         text NOT NULL,
  nombre_completo text,
  telefono        text,
  pc_codigo       text NOT NULL,
  solicitud_id    text,
  sin_leer        integer NOT NULL DEFAULT 0,
  ultimo_mensaje  text,
  fecha_ultimo    timestamptz DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon puede leer chats" ON chats
  FOR SELECT USING (true);
CREATE POLICY "anon puede insertar chats" ON chats
  FOR INSERT WITH CHECK (true);
CREATE POLICY "anon puede actualizar chats" ON chats
  FOR UPDATE USING (true);

-- ── 4. MENSAJES DE CHAT ────────────────────────────────────
CREATE TABLE IF NOT EXISTS mensajes_chat (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  mensaje     text NOT NULL DEFAULT '',
  imagen_url  text,                                  -- base64 o URL externa
  tipo_emisor text NOT NULL DEFAULT 'USUARIO',       -- USUARIO | OPERADOR
  emisor      text,
  pc_codigo   text,
  leido       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mensajes_chat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon puede leer mensajes" ON mensajes_chat
  FOR SELECT USING (true);
CREATE POLICY "anon puede insertar mensajes" ON mensajes_chat
  FOR INSERT WITH CHECK (true);
CREATE POLICY "anon puede actualizar mensajes" ON mensajes_chat
  FOR UPDATE USING (true);

-- ── 5. USUARIOS LANDING ────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario              text UNIQUE NOT NULL,
  nombre               text NOT NULL,
  telefono             text NOT NULL,
  dni                  text,
  nombre_transferencia text,
  pc_codigo            text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon puede leer usuarios"     ON usuarios FOR SELECT USING (true);
CREATE POLICY "anon puede insertar usuarios" ON usuarios FOR INSERT WITH CHECK (true);
CREATE POLICY "anon puede actualizar usuarios" ON usuarios FOR UPDATE USING (true);

-- ── Índices útiles ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_usuarios_pc       ON usuarios(pc_codigo);
CREATE INDEX IF NOT EXISTS idx_billeteras_pc     ON billeteras(pc_codigo);
CREATE INDEX IF NOT EXISTS idx_chats_pc          ON chats(pc_codigo);
CREATE INDEX IF NOT EXISTS idx_mensajes_chat_id  ON mensajes_chat(chat_id);

-- ── Ejemplo: cómo agregar un operador ─────────────────────
-- INSERT INTO operadores (usuario, clave, nombre, rol, tipo_operador, pc_codigo)
-- VALUES ('juan', 'mi_clave', 'Juan García', 'OPERADOR', 'OPERADOR', 'P1');

-- Para FRANQUERO que elige PC al loguear:
-- INSERT INTO operadores (usuario, clave, nombre, rol, tipo_operador, pcs_disponibles)
-- VALUES ('admin', 'admin123', 'Admin', 'ADMIN', 'FRANQUERO', ARRAY['P1','P2','P3','P4','P5']);
