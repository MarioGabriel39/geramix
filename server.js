import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");

const BASE = path.join(os.tmpdir(), "geramix");
const UPLOADS = path.join(BASE, "uploads");
const JOBS = path.join(BASE, "jobs");

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

app.use(express.static(PUBLIC));

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "geramix",
    ffmpeg: Boolean(ffmpegPath)
  });
});

/*
 * Quantos FFmpeg podem trabalhar ao mesmo tempo.
 *
 * 2 é um valor conservador para Render.
 * Pode ser aumentado depois, se os testes mostrarem que o servidor aguenta.
 */
const FFMPEG_CONCURRENCY = Math.max(
  1,
  Math.min(3, Number(process.env.FFMPEG_CONCURRENCY || 2))
);

/*
 * Limite de combinações.
 */
const MAX_COMBINATIONS = 1000;

/*
 * Executa FFmpeg.
 */
function runFFmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "error", ...args],
      {
        cwd
      }
    );

    let err = "";

    p.stderr.on("data", d => {
      err += d.toString();
    });

    p.on("error", reject);

    p.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            err.trim() || `FFmpeg saiu com código ${code}`
          )
        );
      }
    });
  });
}

/*
 * Verifica se existe áudio.
 */
async function hasAudio(input, cwd) {
  try {
    await runFFmpeg(
      [
        "-i",
        input,
        "-map",
        "0:a:0",
        "-c",
        "copy",
        "-f",
        "null",
        "-"
      ],
      cwd
    );

    return true;
  } catch {
    return false;
  }
}

/*
 * Limpa nomes de arquivos.
 */
function safeName(name) {
  return String(name || "video")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-100);
}

/*
 * Normaliza um vídeo para um formato comum.
 *
 * Todos os vídeos passam a ter:
 * 720x1280
 * 30 FPS
 * H.264
 * áudio AAC estéreo
 *
 * Isso permite usar concat com -c copy depois.
 */
async function normalize(input, output, cwd) {
  const audio = await hasAudio(input, cwd);

  const videoArgs = [
    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23"
  ];

  if (audio) {
    await runFFmpeg(
      [
        "-i",
        input,

        ...videoArgs,

        "-map",
        "0:v:0",
        "-map",
        "0:a:0",

        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "128k",
        "-af",
        "aresample=async=1",

        "-movflags",
        "+faststart",

        "-y",
        output
      ],
      cwd
    );
  } else {
    await runFFmpeg(
      [
        "-i",
        input,

        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",

        ...videoArgs,

        "-map",
        "0:v:0",
        "-map",
        "1:a:0",

        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "128k",

        "-shortest",

        "-movflags",
        "+faststart",

        "-y",
        output
      ],
      cwd
    );
  }
}

/*
 * Junta os três vídeos.
 *
 * Aqui usamos stream copy.
 * Não há nova codificação de vídeo.
 */
async function concat3(a, b, c, output, cwd) {
  const list = path.join(
    cwd,
    `concat-${crypto.randomUUID()}.txt`
  );

  const esc = p =>
    p
      .replace(/\\/g, "/")
      .replace(/'/g, "'\\''");

  await fsp.writeFile(
    list,
    `file '${esc(a)}'\nfile '${esc(b)}'\nfile '${esc(c)}'\n`
  );

  try {
    await runFFmpeg(
      [
        "-f",
        "concat",
        "-safe",
        "0",

        "-i",
        list,

        "-c",
        "copy",

        "-movflags",
        "+faststart",

        "-y",
        output
      ],
      cwd
    );
  } finally {
    await fsp.rm(list, {
      force: true
    });
  }
}

/*
 * Executa várias tarefas em paralelo, mas respeitando um limite.
 *
 * Isso é importante:
 *
 * ANTES:
 * vídeo 1 -> espera
 * vídeo 2 -> espera
 * vídeo 3 -> espera
 *
 * AGORA:
 * vídeo 1 ─┐
 * vídeo 2 ─┼─ trabalham juntos
 * vídeo 3 ─┘
 *
 * respeitando FFMPEG_CONCURRENCY.
 */
async function runPool(items, worker, concurrency, onProgress) {
  let nextIndex = 0;
  let completed = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      await worker(items[index], index);

      completed++;

      if (onProgress) {
        onProgress(completed, items.length);
      }
    }
  }

  const workers = [];

  const amount = Math.min(
    concurrency,
    items.length
  );

  for (let i = 0; i < amount; i++) {
    workers.push(runner());
  }

  await Promise.all(workers);
}

const upload = multer({
  dest: UPLOADS,

  limits: {
    files: 30,
    fileSize: 200 * 1024 * 1024
  }
});

const jobs = new Map();

app.post(
  "/api/jobs",
  upload.fields([
    {
      name: "hooks",
      maxCount: 10
    },
    {
      name: "bodies",
      maxCount: 10
    },
    {
      name: "ctas",
      maxCount: 10
    }
  ]),
  async (req, res) => {
    const hooks = req.files?.hooks || [];
    const bodies = req.files?.bodies || [];
    const ctas = req.files?.ctas || [];

    if (
      !hooks.length ||
      !bodies.length ||
      !ctas.length
    ) {
      return res.status(400).json({
        error:
          "Envie pelo menos 1 vídeo em cada categoria."
      });
    }

    const total =
      hooks.length *
      bodies.length *
      ctas.length;

    if (total > MAX_COMBINATIONS) {
      return res.status(400).json({
        error:
          `Limite de ${MAX_COMBINATIONS} combinações por lote.`
      });
    }

    const id = crypto.randomUUID();

    const dir = path.join(
      JOBS,
      id
    );

    await fsp.mkdir(dir, {
      recursive: true
    });

    const job = {
      id,
      status: "processing",
      total,
      done: 0,
      current: "Iniciando…",
      files: [],
      error: null,
      concurrency: FFMPEG_CONCURRENCY
    };

    jobs.set(id, job);

    /*
     * Respondemos imediatamente ao navegador.
     */
    res.json({
      id,
      total
    });

    /*
     * Processamento em segundo plano.
     */
    (async () => {
      try {
        const cats = {
          hooks,
          bodies,
          ctas
        };

        const normalized = {};

        /*
         * ----------------------------------------
         * ETAPA 1
         * Normalização paralela
         * ----------------------------------------
         */

        for (const [key, arr] of Object.entries(cats)) {
          normalized[key] = [];

          const items = arr.map((file, index) => ({
            file,
            index
          }));

          await runPool(
            items,

            async ({ file, index }) => {
              const out = path.join(
                dir,
                `norm-${key}-${index}.mp4`
              );

              const label =
                key === "hooks"
                  ? "ganchos"
                  : key === "bodies"
                  ? "corpos"
                  : "CTAs";

              job.current =
                `Preparando ${label} ${index + 1}/${arr.length}`;

              await normalize(
                file.path,
                out,
                dir
              );

              normalized[key][index] = {
                path: out,
                name: safeName(
                  file.originalname
                )
              };

              await fsp.rm(
                file.path,
                {
                  force: true
                }
              );
            },

            FFMPEG_CONCURRENCY,

            (done, amount) => {
              const label =
                key === "hooks"
                  ? "ganchos"
                  : key === "bodies"
                  ? "corpos"
                  : "CTAs";

              job.current =
                `Preparando ${label}: ${done}/${amount}`;
            }
          );
        }

        /*
         * ----------------------------------------
         * ETAPA 2
         * Cria todas as combinações primeiro.
         * ----------------------------------------
         */

        const combinations = [];

        for (const h of normalized.hooks) {
          for (const b of normalized.bodies) {
            for (const c of normalized.ctas) {
              combinations.push({
                h,
                b,
                c
              });
            }
          }
        }

        /*
         * ----------------------------------------
         * ETAPA 3
         * Geração paralela dos vídeos.
         * ----------------------------------------
         */

        await runPool(
          combinations,

          async ({ h, b, c }, index) => {
            const n = index + 1;

            job.current =
              `Gerando vídeos: ${n}/${total}`;

            const out = path.join(
              dir,
              `video-${String(n).padStart(3, "0")}.mp4`
            );

            await concat3(
              h.path,
              b.path,
              c.path,
              out,
              dir
            );

            job.files.push({
              name: path.basename(out),
              hook: h.name,
              body: b.name,
              cta: c.name,
              index: n
            });

            job.done = job.files.length;

            job.current =
              `Gerando vídeos: ${job.done}/${total}`;
          },

          FFMPEG_CONCURRENCY
        );

        /*
         * Ordena os arquivos para manter:
         * 001, 002, 003...
         */
        job.files.sort(
          (a, b) => a.index - b.index
        );

        /*
         * ----------------------------------------
         * ETAPA 4
         * Cria ZIP.
         * ----------------------------------------
         */

        const zipPath = path.join(
          dir,
          "geramix-videos.zip"
        );

        await new Promise(
          (resolve, reject) => {
            const output =
              fs.createWriteStream(
                zipPath
              );

            const archive =
              archiver("zip", {
                zlib: {
                  level: 0
                }
              });

            output.on(
              "close",
              resolve
            );

            output.on(
              "error",
              reject
            );

            archive.on(
              "error",
              reject
            );

            archive.pipe(output);

            for (const file of job.files) {
              archive.file(
                path.join(
                  dir,
                  file.name
                ),
                {
                  name: file.name
                }
              );
            }

            archive.finalize();
          }
        );

        job.status = "done";
        job.current = "Concluído";
        job.zip =
          `/api/jobs/${id}/zip`;

      } catch (e) {
        console.error(
          "Erro no processamento:",
          e
        );

        job.status = "error";
        job.error =
          e?.message ||
          "Erro desconhecido";
        job.current = "Falhou";
      }
    })();
  }
);

/*
 * Consulta o status do processamento.
 */
app.get(
  "/api/jobs/:id",
  (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        error:
          "Processamento não encontrado."
      });
    }

    res.json(job);
  }
);

/*
 * Download do ZIP.
 */
app.get(
  "/api/jobs/:id/zip",
  (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (
      !job?.zip
    ) {
      return res
        .status(404)
        .send(
          "ZIP ainda não está pronto."
        );
    }

    res.download(
      path.join(
        JOBS,
        req.params.id,
        "geramix-videos.zip"
      ),
      "geramix-videos.zip"
    );
  }
);

/*
 * Download individual.
 */
app.get(
  "/api/jobs/:id/video/:name",
  (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (!job) {
      return res.sendStatus(404);
    }

    const name =
      safeName(req.params.name);

    if (
      !job.files.some(
        f => f.name === name
      )
    ) {
      return res.sendStatus(404);
    }

    res.download(
      path.join(
        JOBS,
        req.params.id,
        name
      ),
      name
    );
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `GeraMix rodando na porta ${PORT}`
    );

    console.log(
      `FFmpeg simultâneos: ${FFMPEG_CONCURRENCY}`
    );
  }
);
