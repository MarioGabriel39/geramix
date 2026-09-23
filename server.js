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

/* =========================================================
   SUPABASE
========================================================= */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas no Render."
  );
}

/* =========================================================
   DIRETÓRIOS
========================================================= */

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

/* =========================================================
   ARQUIVOS PÚBLICOS
========================================================= */

app.use(express.static(PUBLIC));

/* =========================================================
   CONFIGURAÇÃO DO FRONT-END
========================================================= */

app.get("/api/config", (_, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

async function requireAuth(req, res, next) {
  try {
    const authorization =
      String(
        req.headers.authorization || ""
      ).trim();

    let token = "";

    if (
      authorization
        .toLowerCase()
        .startsWith("bearer ")
    ) {
      token =
        authorization
          .slice(7)
          .trim();
    }

    if (!token) {
      token =
        String(
          req.query.token || ""
        ).trim();
    }

    if (!token) {
      console.error(
        "GeraMix: nenhuma sessão foi enviada."
      );

      return res.status(401).json({
        error:
          "Sessão não enviada."
      });
    }

    if (token.startsWith("sb_")) {
      console.error(
        "GeraMix: Publishable Key recebida no lugar do token do usuário."
      );

      return res.status(401).json({
        error:
          "Token de usuário inválido."
      });
    }

    const response =
      await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${token}`,

            apikey:
              SUPABASE_ANON_KEY
          }
        }
      );

    if (!response.ok) {
      let details = "";

      try {
        const data =
          await response.json();

        details =
          data?.msg ||
          data?.message ||
          data?.error_description ||
          data?.error ||
          "";
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: Supabase recusou o token.",
        response.status,
        details
      );

      return res.status(401).json({
        error:
          "Sessão inválida ou expirada."
      });
    }

    const user =
      await response.json();

    if (!user || !user.id) {
      console.error(
        "GeraMix: Supabase respondeu sem usuário."
      );

      return res.status(401).json({
        error:
          "Sessão inválida ou expirada."
      });
    }

    req.user = user;

    next();

  } catch (error) {
    console.error(
      "Erro ao validar sessão:",
      error
    );

    return res.status(401).json({
      error:
        "Não foi possível validar sua sessão."
    });
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "geramix",
    ffmpeg: Boolean(ffmpegPath)
  });
});

/* =========================================================
   CONFIGURAÇÕES
========================================================= */

const FFMPEG_CONCURRENCY = 1;

const MAX_COMBINATIONS = 150;

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(args, cwd) {
  return new Promise(
    (resolve, reject) => {

      const p =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",

            "-threads",
            "1",

            ...args
          ],
          {
            cwd
          }
        );

      let err = "";

      p.stderr.on(
        "data",
        data => {
          err += data.toString();

          if (err.length > 10000) {
            err =
              err.slice(-10000);
          }
        }
      );

      p.on(
        "error",
        reject
      );

      p.on(
        "close",
        code => {

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                err.trim() ||
                `FFmpeg saiu com código ${code}`
              )
            );
          }

        }
      );

    }
  );
}

/* =========================================================
   VERIFICA ÁUDIO
========================================================= */

async function hasAudio(input, cwd) {
  try {

    await runFFmpeg(
      [
        "-i",
        input,

        "-map",
        "0:a:0",

        "-frames:a",
        "0",

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

/* =========================================================
   NORMALIZA UM VÍDEO UMA ÚNICA VEZ
========================================================= */

async function normalizeVideo(
  input,
  output,
  cwd
) {

  const audio =
    await hasAudio(
      input,
      cwd
    );

  const args = [
    "-i",
    input
  ];

  if (!audio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo"
    );
  }

  args.push(
    "-map",
    "0:v:0",

    "-map",
    audio
      ? "0:a:0"
      : "1:a:0",

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease," +
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2," +
      "setsar=1," +
      "fps=30," +
      "format=yuv420p",

    "-c:v",
    "libx264",

    "-preset",
    "ultrafast",

    "-crf",
    "28",

    "-pix_fmt",
    "yuv420p",

    "-r",
    "30",

    "-c:a",
    "aac",

    "-ar",
    "48000",

    "-ac",
    "2",

    "-b:a",
    "96k",

    "-shortest",

    "-y",
    output
  );

  await runFFmpeg(
    args,
    cwd
  );
}

/* =========================================================
   JUNTA 3 VÍDEOS NORMALIZADOS
========================================================= */

async function concatNormalized(
  files,
  output,
  cwd
) {

  const listFile =
    path.join(
      cwd,
      `concat-${crypto.randomUUID()}.txt`
    );

  const content =
    files
      .map(
        file =>
          `file '${path.basename(file).replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  await fsp.writeFile(
    listFile,
    content,
    "utf8"
  );

  try {

    await runFFmpeg(
      [
        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listFile,

        "-c",
        "copy",

        "-y",
        output
      ],
      cwd
    );

  } finally {

    await fsp.rm(
      listFile,
      {
        force: true
      }
    );

  }
}

/* =========================================================
   NOME SEGURO
========================================================= */

function safeName(name) {
  return String(
    name || "video"
  )
    .replace(
      /[^a-zA-Z0-9.*-]/g,
      "*"
    )
    .slice(-100);
}

/* =========================================================
   ORIGINALIDADE
========================================================= */

function calculateOriginality(
  current,
  previous
) {

  if (!previous) {
    return 100;
  }

  let different = 0;

  if (
    current.hook.path !==
    previous.hook.path
  ) {
    different++;
  }

  if (
    current.body.path !==
    previous.body.path
  ) {
    different++;
  }

  if (
    current.cta.path !==
    previous.cta.path
  ) {
    different++;
  }

  return 70 + different * 10;
}

/* =========================================================
   UPLOAD
========================================================= */

const upload =
  multer({
    dest: UPLOADS,

    limits: {
      files: 30,

      fileSize:
        200 * 1024 * 1024
    }
  });

/* =========================================================
   JOBS
========================================================= */

const jobs = new Map();

/* =========================================================
   OBTÉM OS VÍDEOS NORMALIZADOS DE UMA COMBINAÇÃO
========================================================= */

function getCombinationFiles(
  job,
  file
) {

  const dir =
    path.join(
      JOBS,
      job.id
    );

  const hook =
    path.join(
      dir,
      `hook-${String(file.hookIndex).padStart(3, "0")}.mp4`
    );

  const body =
    path.join(
      dir,
      `body-${String(file.bodyIndex).padStart(3, "0")}.mp4`
    );

  const cta =
    path.join(
      dir,
      `cta-${String(file.ctaIndex).padStart(3, "0")}.mp4`
    );

  return [
    hook,
    body,
    cta
  ];
}

/* =========================================================
   CRIA UM VÍDEO TEMPORÁRIO SOB DEMANDA
========================================================= */

async function createVideoForJob(
  job,
  file
) {

  const dir =
    path.join(
      JOBS,
      job.id
    );

  const tempName =
    `temp-${crypto.randomUUID()}.mp4`;

  const output =
    path.join(
      dir,
      tempName
    );

  const sources =
    getCombinationFiles(
      job,
      file
    );

  try {

    await concatNormalized(
      sources,
      output,
      dir
    );

    return output;

  } catch (error) {

    await fsp.rm(
      output,
      {
        force: true
      }
    );

    throw error;
  }
}

/* =========================================================
   CRIA JOB
========================================================= */

app.post(
  "/api/jobs",

  requireAuth,

  upload.fields([
    {
      name: "hooks",
      maxCount: 5
    },

    {
      name: "bodies",
      maxCount: 5
    },

    {
      name: "ctas",
      maxCount: 6
    }
  ]),

  async (req, res) => {

    const hooks =
      req.files?.hooks || [];

    const bodies =
      req.files?.bodies || [];

    const ctas =
      req.files?.ctas || [];

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

    if (
      total >
      MAX_COMBINATIONS
    ) {

      return res.status(400).json({
        error:
          `Limite de ${MAX_COMBINATIONS} combinações por lote.`
      });
    }

    const id =
      crypto.randomUUID();

    const dir =
      path.join(
        JOBS,
        id
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    const job = {
      id,

      userId:
        req.user.id,

      status:
        "processing",

      total,

      done:
        0,

      current:
        "Iniciando…",

      files: [],

      error:
        null,

      mode:
        "montagem-sob-demanda"
    };

    jobs.set(
      id,
      job
    );

    res.json({
      id,
      total
    });

    /* =====================================================
       PROCESSAMENTO
    ===================================================== */

    (async () => {

      const normalizedHooks = [];
      const normalizedBodies = [];
      const normalizedCtas = [];

      try {

        /* ================================================
           1. GANCHOS
        ================================================ */

        job.current =
          "Preparando ganchos…";

        for (
          let i = 0;
          i < hooks.length;
          i++
        ) {

          const file =
            hooks[i];

          const output =
            path.join(
              dir,
              `hook-${String(i + 1).padStart(3, "0")}.mp4`
            );

          await normalizeVideo(
            file.path,
            output,
            dir
          );

          normalizedHooks.push({
            source:
              file,

            path:
              output
          });

          await fsp.rm(
            file.path,
            {
              force: true
            }
          );
        }

        /* ================================================
           2. CORPOS
        ================================================ */

        job.current =
          "Preparando corpos…";

        for (
          let i = 0;
          i < bodies.length;
          i++
        ) {

          const file =
            bodies[i];

          const output =
            path.join(
              dir,
              `body-${String(i + 1).padStart(3, "0")}.mp4`
            );

          await normalizeVideo(
            file.path,
            output,
            dir
          );

          normalizedBodies.push({
            source:
              file,

            path:
              output
          });

          await fsp.rm(
            file.path,
            {
              force: true
            }
          );
        }

        /* ================================================
           3. CTAs
        ================================================ */

        job.current =
          "Preparando CTAs…";

        for (
          let i = 0;
          i < ctas.length;
          i++
        ) {

          const file =
            ctas[i];

          const output =
            path.join(
              dir,
              `cta-${String(i + 1).padStart(3, "0")}.mp4`
            );

          await normalizeVideo(
            file.path,
            output,
            dir
          );

          normalizedCtas.push({
            source:
              file,

            path:
              output
          });

          await fsp.rm(
            file.path,
            {
              force: true
            }
          );
        }

        /* ================================================
           4. PREPARA AS COMBINAÇÕES

           NÃO cria os 150 MP4 aqui.
           Apenas registra as combinações.
        ================================================ */

        job.current =
          "Preparando combinações…";

        let index = 0;

        for (
          let hookIndex = 0;
          hookIndex < normalizedHooks.length;
          hookIndex++
        ) {

          for (
            let bodyIndex = 0;
            bodyIndex < normalizedBodies.length;
            bodyIndex++
          ) {

            for (
              let ctaIndex = 0;
              ctaIndex < normalizedCtas.length;
              ctaIndex++
            ) {

              index++;

              const hook =
                normalizedHooks[
                  hookIndex
                ];

              const body =
                normalizedBodies[
                  bodyIndex
                ];

              const cta =
                normalizedCtas[
                  ctaIndex
                ];

              job.current =
                `Preparando vídeos: ${index}/${total}`;

              /* ==========================================
                 ORIGINALIDADE
              ========================================== */

              const currentCombination = {
                hook: {
                  path:
                    hook.source.path
                },

                body: {
                  path:
                    body.source.path
                },

                cta: {
                  path:
                    cta.source.path
                }
              };

              const previousIndex =
                index - 2;

              const previousCombination =
                previousIndex >= 0
                  ? {
                      hook: {
                        path:
                          normalizedHooks[
                            Math.floor(
                              previousIndex /
                              (
                                normalizedBodies.length *
                                normalizedCtas.length
                              )
                            )
                          ]?.source.path
                      },

                      body: {
                        path:
                          normalizedBodies[
                            Math.floor(
                              (
                                previousIndex /
                                normalizedCtas.length
                              ) %
                              normalizedBodies.length
                            )
                          ]?.source.path
                      },

                      cta: {
                        path:
                          normalizedCtas[
                            previousIndex %
                            normalizedCtas.length
                          ]?.source.path
                      }
                    }
                  : null;

              const originality =
                calculateOriginality(
                  currentCombination,
                  previousCombination
                );

              /* ==========================================
                 SALVA SOMENTE OS DADOS
              ========================================== */

              job.files.push({

                name:
                  `video-${String(index).padStart(3, "0")}.mp4`,

                hook:
                  safeName(
                    hook.source.originalname
                  ),

                body:
                  safeName(
                    body.source.originalname
                  ),

                cta:
                  safeName(
                    cta.source.originalname
                  ),

                hookIndex:
                  hookIndex + 1,

                bodyIndex:
                  bodyIndex + 1,

                ctaIndex:
                  ctaIndex + 1,

                index,

                originality
              });

              job.done =
                index;
            }
          }
        }

        /* ================================================
           5. ORDENA
        ================================================ */

        job.files.sort(
          (a, b) =>
            a.index - b.index
        );

        /* ================================================
           6. FINALIZADO

           O ZIP é montado quando o usuário clicar.
        ================================================ */

        job.current =
          "Concluído";

        job.status =
          "done";

        job.zip =
          `/api/jobs/${id}/zip`;

      } catch (e) {

        console.error(
          "Erro no processamento:",
          e
        );

        job.status =
          "error";

        job.error =
          e?.message ||
          "Erro desconhecido";

        job.current =
          "Falhou";

        await Promise.all(
          [
            ...hooks,
            ...bodies,
            ...ctas
          ].map(
            file =>
              fsp.rm(
                file.path,
                {
                  force: true
                }
              )
          )
        );
      }

    })();

  }
);

/* =========================================================
   CONSULTA JOB
========================================================= */

app.get(
  "/api/jobs/:id",

  requireAuth,

  (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({
        error:
          "Processamento não encontrado."
      });
    }

    if (
      job.userId !==
      req.user.id
    ) {

      return res.status(404).json({
        error:
          "Processamento não encontrado."
      });
    }

    res.json(job);
  }
);

/* =========================================================
   DOWNLOAD ZIP
========================================================= */

app.get(
  "/api/jobs/:id/zip",

  requireAuth,

  async (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res
        .status(404)
        .send(
          "Processamento não encontrado."
        );
    }

    if (
      job.userId !==
      req.user.id
    ) {

      return res
        .status(404)
        .send(
          "Processamento não encontrado."
        );
    }

    if (
      job.status !==
      "done"
    ) {

      return res
        .status(400)
        .send(
          "O processamento ainda não terminou."
        );
    }

    res.statusCode = 200;

    res.setHeader(
      "Content-Type",
      "application/zip"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="geramix-videos.zip"'
    );

    const archive =
      archiver(
        "zip",
        {
          zlib: {
            level: 0
          }
        }
      );

    archive.on(
      "error",
      error => {

        console.error(
          "Erro criando ZIP:",
          error
        );

        if (!res.headersSent) {

          res
            .status(500)
            .send(
              "Erro ao criar ZIP."
            );

        } else {

          res.destroy(error);

        }
      }
    );

    archive.pipe(res);

    try {

      for (
        const file
        of job.files
      ) {

        const tempVideo =
          await createVideoForJob(
            job,
            file
          );

        try {

          await new Promise(
            (resolve, reject) => {

              const input =
                fs.createReadStream(
                  tempVideo
                );

              input.on(
                "error",
                reject
              );

              input.on(
                "close",
                resolve
              );

              archive.append(
                input,
                {
                  name:
                    file.name
                }
              );

            }
          );

        } finally {

          await fsp.rm(
            tempVideo,
            {
              force: true
            }
          );

        }
      }

      await archive.finalize();

    } catch (error) {

      console.error(
        "Erro no download ZIP:",
        error
      );

      await fsp.rm(
        path.join(
          JOBS,
          job.id
        ),
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});

      if (!res.headersSent) {

        return res
          .status(500)
          .send(
            "Erro ao criar ZIP."
          );
      }

      res.destroy(error);
    }

  }
);

/* =========================================================
   DOWNLOAD / VISUALIZAÇÃO DE VÍDEO
========================================================= */

app.get(
  "/api/jobs/:id/video/:name",

  requireAuth,

  async (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.sendStatus(404);
    }

    if (
      job.userId !==
      req.user.id
    ) {
      return res.sendStatus(404);
    }

    const name =
      safeName(
        req.params.name
      );

    const file =
      job.files.find(
        item =>
          item.name === name
      );

    if (!file) {
      return res.sendStatus(404);
    }

    let tempVideo = null;

    try {

      tempVideo =
        await createVideoForJob(
          job,
          file
        );

      const stat =
        await fsp.stat(
          tempVideo
        );

      const size =
        stat.size;

      const range =
        req.headers.range;

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      if (!range) {

        res.setHeader(
          "Content-Length",
          size
        );

        res.setHeader(
          "Content-Disposition",
          `inline; filename="${name}"`
        );

        const stream =
          fs.createReadStream(
            tempVideo
          );

        stream.on(
          "close",
          () => {

            fsp.rm(
              tempVideo,
              {
                force: true
              }
            ).catch(() => {});

          }
        );

        stream.on(
          "error",
          error => {

            console.error(
              "Erro enviando vídeo:",
              error
            );

            fsp.rm(
              tempVideo,
              {
                force: true
              }
            ).catch(() => {});

            if (!res.headersSent) {

              res.sendStatus(500);

            } else {

              res.destroy(error);

            }

          }
        );

        return stream.pipe(res);
      }

      const matches =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (!matches) {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        );

        return res
          .status(416)
          .set(
            "Content-Range",
            `bytes */${size}`
          )
          .end();
      }

      let start =
        matches[1]
          ? Number(matches[1])
          : 0;

      let end =
        matches[2]
          ? Number(matches[2])
          : size - 1;

      if (
        !matches[1] &&
        matches[2]
      ) {

        const suffixLength =
          Number(matches[2]);

        start =
          Math.max(
            0,
            size - suffixLength
          );

        end =
          size - 1;
      }

      if (
        start < 0 ||
        start >= size ||
        end < start
      ) {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        );

        return res
          .status(416)
          .set(
            "Content-Range",
            `bytes */${size}`
          )
          .end();
      }

      end =
        Math.min(
          end,
          size - 1
        );

      const chunkSize =
        end - start + 1;

      res.statusCode = 206;

      res.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${size}`
      );

      res.setHeader(
        "Content-Length",
        chunkSize
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${name}"`
      );

      const stream =
        fs.createReadStream(
          tempVideo,
          {
            start,
            end
          }
        );

      stream.on(
        "close",
        () => {

          fsp.rm(
            tempVideo,
            {
              force: true
            }
          ).catch(() => {});

        }
      );

      stream.on(
        "error",
        error => {

          console.error(
            "Erro enviando trecho do vídeo:",
            error
          );

          fsp.rm(
            tempVideo,
            {
              force: true
            }
          ).catch(() => {});

          if (!res.headersSent) {

            res.sendStatus(500);

          } else {

            res.destroy(error);

          }

        }
      );

      stream.pipe(res);

    } catch (error) {

      if (tempVideo) {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        ).catch(() => {});

      }

      console.error(
        "Erro montando vídeo:",
        error
      );

      if (!res.headersSent) {

        return res
          .status(500)
          .send(
            "Erro ao montar o vídeo."
          );
      }

      res.destroy(error);
    }

  }
);

/* =========================================================
   ERROS
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    if (
      error instanceof
      multer.MulterError
    ) {

      console.error(
        "Erro Multer:",
        error
      );

      return res.status(400).json({
        error:
          "Erro no envio dos vídeos: " +
          error.message
      });
    }

    if (error) {

      console.error(
        "Erro no servidor:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Erro interno do servidor."
      });
    }

    next();
  }
);

/* =========================================================
   SERVIDOR
========================================================= */

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
