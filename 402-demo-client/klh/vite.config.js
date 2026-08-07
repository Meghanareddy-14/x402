import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  define: {
    // Make sure VITE_API_URL is available
    __API_URL__: JSON.stringify(process.env.VITE_API_URL || 'http://localhost:4021'),
  },
})
