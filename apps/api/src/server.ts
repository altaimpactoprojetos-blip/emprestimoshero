import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`API em execução na porta ${config.port} (${config.env})`);
});
