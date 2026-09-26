import type { Metadata } from 'next';
import '../globals.css';

export const metadata: Metadata = {
  title: 'Order',
  description: 'Order from your table',
};

export default function GuestOrderLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}
