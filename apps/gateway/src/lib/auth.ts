/**
 * NextAuth v5 configuration, Credentials (email + password) only.
 *
 * Admin accounts live in env var `ADMIN_CREDENTIALS` as a JSON array
 *   [{ "email": "admin@example.com", "hash": "scrypt$..." }, ...]
 */
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { env, adminCredentials, adminEmailAllowlist } from './env';
import { verifyPassword } from './password';

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.NEXTAUTH_SECRET,
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8 },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? '')
          .trim()
          .toLowerCase();
        const password = String(creds?.password ?? '');
        if (!email || !password) return null;
        if (!adminEmailAllowlist().includes(email)) return null;
        const record = adminCredentials().find((c) => c.email === email);
        if (!record) return null;
        const ok = await verifyPassword(password, record.hash);
        if (!ok) return null;
        return { id: email, email, name: email };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.email) token.email = user.email.toLowerCase();
      return token;
    },
    session({ session, token }) {
      if (token.email) session.user.email = token.email as string;
      return session;
    },
  },
  pages: {
    signIn: '/admin/login',
    error: '/admin/login',
  },
});
