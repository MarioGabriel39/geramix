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
            "Authorization":
              `Bearer ${token}`,

            "apikey":
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

const MAX_COMBINATIONS = 1000;


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

  /*
   * Se não houver áudio,
   * adiciona silêncio.
   */
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

    /*
     * Prioridade para velocidade.
     */
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

    /*
     * Arquivo intermediário.
     * Não usamos faststart aqui.
     */
    "-y",
    output
  );

  await runFFmpeg(
    args,
    cwd
  );
}


/* =========================================================
   JUNTA VÍDEOS NORMALIZADOS
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
      /[^a-zA-Z0-9._-]/g,
      "_"
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
   CRIA JOB
   ========================================================= */

app.post(
  "/api/jobs",

  requireAuth,

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
        "montagem-direta"
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
           4. COMBINAÇÕES
           ================================================ */

        job.current =
          "Montando vídeos…";

        let index = 0;

        for (
          const hook
          of normalizedHooks
        ) {

          for (
            const body
            of normalizedBodies
          ) {

            for (
              const cta
              of normalizedCtas
            ) {

              index++;

              const output =
                path.join(
                  dir,
                  `video-${String(index).padStart(3, "0")}.mp4`
                );

              job.current =
                `Gerando vídeos: ${index}/${total}`;

              /*
               * Aqui ocorre somente a junção.
               *
               * Não há nova codificação.
               */
              await concatNormalized(
                [
                  hook.path,
                  body.path,
                  cta.path
                ],
                output,
                dir
              );


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

              const previousCombination =
                index > 1
                  ? {
                      hook: {
                        path:
                          normalizedHooks[
                            Math.floor(
                              (index - 2) /
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
                                (index - 2) /
                                normalizedCtas.length
                              ) %
                              normalizedBodies.length
                            )
                          ]?.source.path
                      },

                      cta: {
                        path:
                          normalizedCtas[
                            (index - 2) %
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
                 SALVA RESULTADO
                 ========================================== */

              job.files.push({

                name:
                  path.basename(
                    output
                  ),

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
           6. ZIP
           ================================================ */

        job.current =
          "Criando ZIP…";

        const zipPath =
          path.join(
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
              archiver(
                "zip",
                {
                  zlib: {
                    level: 0
                  }
                }
              );

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

            archive.pipe(
              output
            );

            for (
              const file
              of job.files
            ) {

              archive.file(
                path.join(
                  dir,
                  file.name
                ),
                {
                  name:
                    file.name
                }
              );
            }

            archive.finalize();
          }
        );


        /* ================================================
           7. FINALIZADO
           ================================================ */

        job.status =
          "done";

        job.current =
          "Concluído";

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

  (req, res) => {

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

    if (!job.zip) {

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


/* =========================================================
   DOWNLOAD VÍDEO
   ========================================================= */

app.get(
  "/api/jobs/:id/video/:name",

  requireAuth,

  (req, res) => {

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

    if (
      !job.files.some(
        file =>
          file.name === name
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
