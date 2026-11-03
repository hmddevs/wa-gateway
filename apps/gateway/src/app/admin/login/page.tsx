import { redirect } from 'next/navigation';
import { auth, signIn } from '@/lib/auth';
import { AuthError } from 'next-auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function LoginPage(props: { searchParams: Promise<{ error?: string }> }) {
  const session = await auth();
  if (session?.user?.email) redirect('/admin');
  const { error } = await props.searchParams;

  async function signInAction(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    try {
      await signIn('credentials', {
        email,
        password,
        redirectTo: '/admin/step-up',
      });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect('/admin/login?error=CredentialsSignin');
      }
      throw err;
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">HMD WA Gateway</CardTitle>
          <CardDescription>Admin sign-in</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Invalid email or password.
            </div>
          ) : null}

          <form action={signInAction} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
