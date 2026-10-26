import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyFont, getFont } from './font';
import { initializeTheme } from './theme';
import './index.css';

applyFont(getFont());
initializeTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
