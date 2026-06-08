-- Phase 3: devices table for push notifications
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_token VARCHAR(512) NOT NULL,
  platform VARCHAR(16) DEFAULT 'ios',
  device_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_token)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
