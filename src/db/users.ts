import { db } from "./client";

export type UserRole = "superusuario" | "admin" | "editor" | "visor";

export interface AppUser {
  id: number;
  username: string;
  role: UserRole;
  active: number;
  created_at: string;
}

export function getUsers(): AppUser[] {
  return db.query<AppUser, []>(`SELECT id, username, role, active, created_at FROM users ORDER BY created_at ASC`).all();
}

export function getUserById(id: number): AppUser | null {
  return db.query<AppUser, [number]>(`SELECT id, username, role, active, created_at FROM users WHERE id = ?`).get(id) || null;
}

export function getUserByUsername(username: string): (AppUser & { password_hash: string }) | null {
  return db.query<AppUser & { password_hash: string }, [string]>(
    `SELECT id, username, role, active, created_at, password_hash FROM users WHERE username = ?`
  ).get(username) || null;
}

export function createUser(username: string, password_hash: string, role: UserRole): AppUser {
  const row = db.query<{ id: number; created_at: string }, [string, string, string]>(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id, created_at`
  ).get(username, password_hash, role);
  return { id: row!.id, username, role, active: 1, created_at: row!.created_at };
}

export function updateUser(
  id: number,
  data: { username?: string; password_hash?: string; role?: UserRole; active?: number }
): AppUser | null {
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (data.username !== undefined) { fields.push("username = ?"); values.push(data.username); }
  if (data.password_hash !== undefined) { fields.push("password_hash = ?"); values.push(data.password_hash); }
  if (data.role !== undefined) { fields.push("role = ?"); values.push(data.role); }
  if (data.active !== undefined) { fields.push("active = ?"); values.push(data.active); }
  if (fields.length === 0) return getUserById(id);
  db.run(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...values, id]);
  return getUserById(id);
}

export function deleteUser(id: number): void {
  db.run(`DELETE FROM users WHERE id = ?`, [id]);
}
