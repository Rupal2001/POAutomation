import { USER_ROLES, type UserRole } from "./session";

export function publicUser(row: any) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function validateAccount(values: {
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  temporaryPassword?: string;
}) {
  if (!/^[a-z0-9._-]{3,40}$/.test(values.username)) return "Username must be 3–40 characters using letters, numbers, dots, dashes or underscores.";
  if (values.displayName.length < 2 || values.displayName.length > 100) return "Display name must be between 2 and 100 characters.";
  if (values.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 254)) return "Enter a valid work email address.";
  if (!(USER_ROLES as readonly string[]).includes(values.role)) return "Choose a valid role.";
  if (values.temporaryPassword !== undefined && (values.temporaryPassword.length < 10 || values.temporaryPassword.length > 200)) return "Temporary password must be between 10 and 200 characters.";
  if (values.temporaryPassword !== undefined && [values.username.toLowerCase(), "admin"].includes(values.temporaryPassword.toLowerCase())) {
    return "Temporary password cannot be the username or the default password.";
  }
  return "";
}
