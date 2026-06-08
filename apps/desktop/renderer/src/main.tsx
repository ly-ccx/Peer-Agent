import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceProvider } from './appearance/AppearanceProvider';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </React.StrictMode>,
);
