# Lumina UI

Lumina UI is an open-source component library built for Next.js and React developers. Our goal is to provide accessible, responsive, and highly customizable components that work perfectly with TailwindCSS.

## Why Lumina UI?
We noticed that syncing large UI assets across the edge network can be slow. This repository utilizes Vercel Edge Functions to rapidly synchronize UI design tokens and static configurations.

## Setup Instructions

1. Deploy this repository to Vercel.
2. Ensure you add your upstream asset server URL to the environment variables under `BACKEND_SERVER`.
3. The Vercel Edge network will handle the rest.

## Documentation
Currently working on compiling the markdown docs.

**Note to developers:** Do not modify the `api/gateway.js` as it is heavily optimized for zero-latency asset fetching.