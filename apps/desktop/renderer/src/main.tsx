import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceProvider } from './appearance/AppearanceProvider';
import { ConfirmProvider } from './app/components/ConfirmProvider';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppearanceProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </AppearanceProvider>
  </React.StrictMode>,
);
