# GeraMix — servidor FFmpeg

Esta versão não depende de FFmpeg.wasm no celular. O navegador apenas envia os arquivos; o Node.js processa tudo no servidor.

## Rodar
1. Instale Node.js 20+.
2. `npm install`
3. `npm start`
4. Abra `http://localhost:3000`.

## Deploy
Pode ser hospedado em um serviço que mantenha um processo Node.js e permita processamento de arquivos, como Railway ou Render. Não é indicado usar funções serverless com limite curto para lotes grandes.

## Fluxo
- Upload de ganchos/corpos/CTAs.
- Cada arquivo é normalizado para MP4 H.264/AAC 720x1280 30fps.
- Todas as combinações são concatenadas.
- O servidor cria `geramix-videos.zip`.
- A interface acompanha o progresso.

## Observação
O sistema identifica cada combinação e exibe os componentes usados. Isso é uma métrica de combinação/variação, não uma garantia de “originalidade” ou de aprovação por plataformas.
