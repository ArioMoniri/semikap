import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UpdatePrompt } from './components/UpdatePrompt';
import { initTheme } from './lib/ui/theme';
import { startNativeOrtBridge } from './lib/inference/native-backend';
import './index.css';

initTheme();
// Desktop only: lets the inference worker run ONNX Runtime natively in Rust.
startNativeOrtBridge();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element in index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <UpdatePrompt />
    </ErrorBoundary>
  </StrictMode>
);
