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
import { createClient } from "@supabase/supabase-js";

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");

const BASE = path.join(os.tmpdir(), "geramix");
const UPLOADS = path.join(BASE, "uploads");
const JOBS = path.join(BASE, "jobs");

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY;

if (
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY
) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas no Render."
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

await Promise.all([
  fsp.mkdir(
    UPLOADS,
    { recursive: true }
  ),

  fsp.mkdir(
    JOBS,
    { recursive: true }
  )
]);

app.use(
  express.static(PUBLIC)
);


/* =========================================================
   AUTENTICAÇÃO
   ========================================================= */

async function requireAuth(
  req,
  res,
  next
) {
  try {
    const authorization =
      req.headers.authorization || "";

    if (
      !authorization.startsWith(
        "Bearer "
      )
    ) {
      return res.status(401).json({
        error:
          "Não autenticado."
      });
    }

    const token =
      authorization.substring(7);

    if (!token) {
      return res.status(401).json({
        error:
          "Token de acesso ausente."
      });
    }

    const {
      data,
      error
    } =
      await supabase.auth.getUser(
        token
      );

    if (
      error ||
      !data?.user
    ) {
      return res.status(401).json({
        error:
          "Sessão inválida ou expirada."
      });
    }

    req.user =
      data.user;

    next();

  } catch (error) {
    console.error(
      "Erro na autenticação:",
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

app.get(
  "/health",
  (_, res) => {
    res.json({
      ok: true,
      service: "geramix",
      ffmpeg:
        Boolean(ffmpegPath)
    });
  }
);


/* =========================================================
   CONFIGURAÇÕES
   ========================================================= */

const FFMPEG_CONCURRENCY =
  Math.max(
    1,
    Math.min(
      3,
      Number(
        process.env.FFMPEG_CONCURRENCY ||
        2
      )
    )
  );

const MAX_COMBINATIONS =
  1000;


/* =========================================================
   FFmpeg
   ========================================================= */

function runFFmpeg(
  args,
  cwd
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {

      const p =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            ...args
          ],
          {
            cwd
          }
        );

      let err = "";

      p.stderr.on(
        "data",
        d => {
          err +=
            d.toString();
        }
      );

      p.on(
        "error",
        reject
      );

      p.on(
        "close",
        code => {

          if (
            code === 0
          ) {
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

async function hasAudio(
  input,
  cwd
) {
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


/* =========================================================
   NOME SEGURO
   ========================================================= */

function safeName(
  name
) {
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

  return 70 + (
    different * 10
  );
}


/* =========================================================
   CONCATENA 3 VÍDEOS
   ========================================================= */

async function concat3(
  hook,
  body,
  cta,
  output,
  cwd
) {

  const inputs = [
    hook,
    body,
    cta
  ];

  const audioFlags = [];

  for (
    const input
    of inputs
  ) {

    audioFlags.push(
      await hasAudio(
        input,
        cwd
      )
    );

  }

  const args = [];


  /* Entradas */

  for (
    const input
    of inputs
  ) {

    args.push(
      "-i",
      input
    );

  }


  /* Áudios silenciosos */

  const silentIndexes = [];

  for (
    let i = 0;
    i < inputs.length;
    i++
  ) {

    if (
      !audioFlags[i]
    ) {

      const silentIndex =
        inputs.length +
        silentIndexes.length;

      silentIndexes.push(
        silentIndex
      );

      args.push(
        "-f",
        "lavfi",
        "-t",
        "86400",
        "-i",
        "anullsrc=r=48000:cl=stereo"
      );

    }

  }


  const filterParts = [];


  /* Vídeos */

  for (
    let i = 0;
    i < inputs.length;
    i++
  ) {

    filterParts.push(
      `[${i}:v:0]` +
      `scale=720:1280:force_original_aspect_ratio=decrease,` +
      `pad=720:1280:(ow-iw)/2:(oh-ih)/2,` +
      `setsar=1,` +
      `fps=30,` +
      `format=yuv420p,` +
      `setpts=PTS-STARTPTS` +
      `[v${i}]`
    );

  }


  /* Áudios */

  let silentCounter = 0;

  for (
    let i = 0;
    i < inputs.length;
    i++
  ) {

    if (
      audioFlags[i]
    ) {

      filterParts.push(
        `[${i}:a:0]` +
        `aresample=48000,` +
        `aformat=sample_rates=48000:channel_layouts=stereo,` +
        `asetpts=PTS-STARTPTS` +
        `[a${i}]`
      );

    } else {

      const silentIndex =
        inputs.length +
        silentCounter;

      filterParts.push(
        `[${silentIndex}:a:0]` +
        `asetpts=PTS-STARTPTS` +
        `[a${i}]`
      );

      silentCounter++;

    }

  }


  /* Concat */

  let concatInputs = "";

  for (
    let i = 0;
    i < inputs.length;
    i++
  ) {

    concatInputs +=
      `[v${i}][a${i}]`;

  }

  filterParts.push(
    `${concatInputs}` +
    `concat=n=3:v=1:a=1:` +
    `[vout][aout]`
  );


  const filterComplex =
    filterParts.join(";");


  args.push(

    "-filter_complex",
    filterComplex,

    "-map",
    "[vout]",

    "-map",
    "[aout]",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

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
    "128k",

    "-movflags",
    "+faststart",

    "-y",
    output

  );


  await runFFmpeg(
    args,
    cwd
  );
}


/* =========================================================
   POOL DE PROCESSAMENTO
   ========================================================= */

async function runPool(
  items,
  worker,
  concurrency,
  onProgress
) {

  let nextIndex = 0;
  let completed = 0;

  async function runner() {

    while (true) {

      const index =
        nextIndex++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      await worker(
        items[index],
        index
      );

      completed++;

      if (
        onProgress
      ) {

        onProgress(
          completed,
          items.length
        );

      }

    }

  }


  const amount =
    Math.min(
      concurrency,
      items.length
    );

  const workers = [];


  for (
    let i = 0;
    i < amount;
    i++
  ) {

    workers.push(
      runner()
    );

  }


  await Promise.all(
    workers
  );
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
        200 *
        1024 *
        1024
    }
  });


/* =========================================================
   JOBS
   ========================================================= */

const jobs =
  new Map();


/* =========================================================
   CRIA PROCESSAMENTO
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

  async (
    req,
    res
  ) => {

    const hooks =
      req.files?.hooks ||
      [];

    const bodies =
      req.files?.bodies ||
      [];

    const ctas =
      req.files?.ctas ||
      [];


    if (
      !hooks.length ||
      !bodies.length ||
      !ctas.length
    ) {

      return res
        .status(400)
        .json({
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

      return res
        .status(400)
        .json({
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


    /*
     * IMPORTANTE:
     * Este processamento pertence
     * ao usuário autenticado.
     */

    const job = {

      id,

      userId:
        req.user.id,

      status:
        "processing",

      total,

      done: 0,

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


    (async () => {

      try {

        const combinations =
          [];


        for (
          const hook
          of hooks
        ) {

          for (
            const body
            of bodies
          ) {

            for (
              const cta
              of ctas
            ) {

              combinations.push({
                hook,
                body,
                cta
              });

            }

          }

        }


        job.current =
          "Montando vídeos…";


        await runPool(

          combinations,

          async (
            {
              hook,
              body,
              cta
            },
            index
          ) => {

            const n =
              index + 1;


            const output =
              path.join(
                dir,
                `video-${String(n).padStart(3, "0")}.mp4`
              );


            job.current =
              `Gerando vídeos: ${n}/${total}`;


            await concat3(

              hook.path,

              body.path,

              cta.path,

              output,

              dir

            );


            const originality =
              calculateOriginality(

                combinations[index],

                combinations[
                  index - 1
                ]

              );


            job.files.push({

              name:
                path.basename(
                  output
                ),

              hook:
                safeName(
                  hook.originalname
                ),

              body:
                safeName(
                  body.originalname
                ),

              cta:
                safeName(
                  cta.originalname
                ),

              index:
                n,

              originality

            });


            job.done =
              job.files.length;

          },

          FFMPEG_CONCURRENCY

        );


        job.files.sort(
          (a, b) =>
            a.index -
            b.index
        );


        /*
         * Apaga os uploads originais.
         */

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


        job.current =
          "Criando ZIP…";


        const zipPath =
          path.join(
            dir,
            "geramix-videos.zip"
          );


        await new Promise(
          (
            resolve,
            reject
          ) => {

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
   CONSULTA DO PROCESSAMENTO
   ========================================================= */

app.get(
  "/api/jobs/:id",

  requireAuth,

  (
    req,
    res
  ) => {

    const job =
      jobs.get(
        req.params.id
      );


    if (!job) {

      return res
        .status(404)
        .json({
          error:
            "Processamento não encontrado."
        });

    }


    /*
     * Só o dono pode consultar
     * o processamento.
     */

    if (
      job.userId !==
      req.user.id
    ) {

      return res
        .status(404)
        .json({
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

  (
    req,
    res
  ) => {

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
   DOWNLOAD / VÍDEO
   ========================================================= */

app.get(
  "/api/jobs/:id/video/:name",

  requireAuth,

  (
    req,
    res
  ) => {

    const job =
      jobs.get(
        req.params.id
      );


    if (!job) {

      return res.sendStatus(
        404
      );

    }


    if (
      job.userId !==
      req.user.id
    ) {

      return res.sendStatus(
        404
      );

    }


    const name =
      safeName(
        req.params.name
      );


    if (
      !job.files.some(
        f =>
          f.name === name
      )
    ) {

      return res.sendStatus(
        404
      );

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
