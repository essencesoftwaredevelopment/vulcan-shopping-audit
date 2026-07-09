import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  async rewrites() {
    // The audit page is the hand-built static file in public/ — serve it at the root.
    return [{ source: '/', destination: '/index.html' }];
  },
};

export default withWorkflow(nextConfig);
