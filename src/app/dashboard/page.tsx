import { redirect } from 'next/navigation';

// /dashboard redirects to the main vault dashboard at /
export default function DashboardPage() {
  redirect('/');
}
