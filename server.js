import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { Readable } from "stream";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");
const BASE = path.join(os.tmpdir(), "geramix");
const UPLOADS = path.join(BASE, "uploads");
const JOBS = path.join(BASE, "jobs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_DOWNLOAD_BUCKET = "geramix-downloads";

const MAX_COMBINATIONS = 150;
const MAX_HOOKS = 5;
const MAX_BODIES = 5;
const MAX_CTAS = 6;
const MAX_FILE_SIZE = 200 * 1024 * 1024;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas."
  );
}

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

app.use(express.static(PUBLIC));

app.get("/api/config", (_, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "geramix",
    ffmpeg: Boolean(ffmpegPath)
  });
});

const upload = multer({
  dest: UPLOADS,
  limits: {
    files: 30,
    fileSize: MAX_FILE_SIZE
  }
});

const jobs = new Map();

function safeName(name) {
  return String(name || "video.mp4")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-100);
}

function encodedStoragePath(storagePath) {
  return String(storagePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

async function requireAuth(req, res, next) {
  try {
    const authorization =
      String(req.headers.authorization || "").trim();

    let token =
      authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice(7).trim()
        : "";

    if (!token) {
      token =
        String(req.query.token || "").trim();
    }

    if (!token || token.startsWith("sb_")) {
      return res.status(401).json({
        error: "Sessão inválida ou não enviada."
      });
    }

    const response =
      await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_ANON_KEY
          }
        }
      );

    if (!response.ok) {
      return res.status(401).json({
        error: "Sessão inválida ou expirada."
      });
    }

    const user =
      await response.json();

    if (!user?.id) {
      return res.status(401).json({
        error: "Sessão inválida ou expirada."
      });
    }

    req.user = user;
    req.accessToken = token;

    next();
  } catch (error) {
    console.error(
      "GeraMix auth:",
      error
    );

    return res.status(401).json({
      error:
        "Não foi possível validar sua sessão."
    });
  }
}

/* =========================================================
   RPC SUPABASE
========================================================= */

async function rpc(
  name,
  body,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/${name}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        },

        body:
          JSON.stringify(body)
      }
    );

  let data = null;

  try {
    data =
      await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.msg ||
      data?.error_description ||
      data?.error ||
      `RPC ${name} falhou.`
    );
  }

  return Array.isArray(data)
    ? data[0]
    : data;
}

/* =========================================================
   RESERVA DE COTA
========================================================= */

async function reserveVideoQuota(
  userId,
  accessToken,
  amount
) {
  const result =
    await rpc(
      "reserve_video_quota",
      {
        p_user_id: userId,
        p_amount: amount
      },
      accessToken
    );

  if (!result) {
    throw new Error(
      "O servidor não recebeu a resposta da cota."
    );
  }

  return {
    allowed:
      Boolean(result.allowed),

    videosUsed:
      Number(result.videos_used || 0),

    monthlyLimit:
      Number(result.monthly_limit || 0),

    message:
      result.message || ""
  };
}

/* =========================================================
   DEVOLVE COTA
========================================================= */

async function releaseVideoQuota(
  userId,
  accessToken,
  amount
) {
  if (!amount) {
    return;
  }

  try {
    await rpc(
      "release_video_quota",
      {
        p_user_id: userId,
        p_amount: amount
      },
      accessToken
    );
  } catch (error) {
    console.error(
      "GeraMix release quota:",
      error
    );
  }
}

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(
  args,
  cwd
) {
  return new Promise(
    (resolve, reject) => {
      const child =
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
          { cwd }
        );

      let stderr = "";

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            12000
          ) {
            stderr =
              stderr.slice(-12000);
          }
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        code => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                stderr.trim() ||
                  `FFmpeg saiu com código ${code}.`
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
        "-frames:a",
        "1",
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
   NORMALIZA VÍDEO
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
   JUNTA 3 VÍDEOS
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
        file => {
          const base =
            path.basename(file)
              .replace(
                /'/g,
                "'\\''"
              );

          return `file '${base}'`;
        }
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

        "-movflags",
        "+faststart",

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
   ORIGINALIDADE
========================================================= */

function originality(
  current,
  previous
) {
  if (!previous) {
    return 100;
  }

  let different = 0;

  if (
    current.hook !==
    previous.hook
  ) {
    different++;
  }

  if (
    current.body !==
    previous.body
  ) {
    different++;
  }

  if (
    current.cta !==
    previous.cta
  ) {
    different++;
  }

  return 70 +
    different * 10;
}

/* =========================================================
   BAIXA INPUT DO SUPABASE STORAGE
========================================================= */

async function downloadStorageObject(
  storagePath,
  accessToken,
  outputPath
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(storagePath)}`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (
    !response.ok ||
    !response.body
  ) {
    let detail = "";

    try {
      const data =
        await response.json();

      detail =
        data?.message ||
        data?.error ||
        "";
    } catch {}

    throw new Error(
      detail ||
        `Não foi possível baixar o vídeo de origem (${response.status}).`
    );
  }

  const output =
    fs.createWriteStream(
      outputPath
    );

  await new Promise(
    (resolve, reject) => {
      const source =
        Readable.fromWeb(
          response.body
        );

      source.on(
        "error",
        reject
      );

      output.on(
        "error",
        reject
      );

      output.on(
        "finish",
        resolve
      );

      source.pipe(
        output
      );
    }
  );
}

/* =========================================================
   VALIDA INPUTS DO STORAGE
========================================================= */

function validateStorageInputs(
  inputs,
  userId
) {
  const lists = [
    [
      "hooks",
      inputs?.hooks,
      MAX_HOOKS
    ],

    [
      "bodies",
      inputs?.bodies,
      MAX_BODIES
    ],

    [
      "ctas",
      inputs?.ctas,
      MAX_CTAS
    ]
  ];

  return lists.map(
    ([field, list, max]) => {
      if (
        !Array.isArray(list) ||
        !list.length
      ) {
        throw new Error(
          "Envie pelo menos 1 vídeo em cada categoria."
        );
      }

      if (
        list.length > max
      ) {
        throw new Error(
          `Limite excedido para ${field}.`
        );
      }

      return list.map(
        (
          item,
          index
        ) => {
          const storagePath =
            String(
              item?.storagePath ||
                ""
            ).trim();

          const originalName =
            String(
              item?.originalName ||
                item?.originalname ||
                `${field}-${index + 1}.mp4`
            ).trim();

          const prefix =
            `${userId}/inputs/`;

          if (
            !storagePath.startsWith(
              prefix
            )
          ) {
            throw new Error(
              `Arquivo de origem inválido em ${field}.`
            );
          }

          return {
            storagePath,
            originalname:
              originalName,
            path: null
          };
        }
      );
    }
  );
}

/* =========================================================
   REMOVE OBJETO DO STORAGE
========================================================= */

async function deleteStorageObject(
  storagePath,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(storagePath)}`,
      {
        method: "DELETE",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    throw new Error(
      `Supabase não conseguiu excluir o arquivo (${response.status}).`
    );
  }
}

/* =========================================================
   REGISTRA DOWNLOAD
========================================================= */

async function registerDownload(
  {
    userId,
    jobId,
    fileName,
    storagePath,
    originalityScore,
    accessToken
  }
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY,

          Prefer:
            "return=minimal"
        },

        body:
          JSON.stringify({
            user_id:
              userId,

            job_id:
              jobId,

            file_name:
              fileName,

            storage_path:
              storagePath,

            originality:
              originalityScore
          })
      }
    );

  if (!response.ok) {
    let detail = "";

    try {
      const data =
        await response.json();

      detail =
        data?.message ||
        data?.error ||
        "";
    } catch {}

    throw new Error(
      detail ||
        `Não foi possível registrar o vídeo (${response.status}).`
    );
  }
}

/* =========================================================
   ENVIA VÍDEO FINAL PARA STORAGE
========================================================= */

async function uploadVideoToStorage(
  localPath,
  storagePath,
  accessToken
) {
  const stat =
    await fsp.stat(
      localPath
    );

  const stream =
    fs.createReadStream(
      localPath
    );

  try {
    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(storagePath)}`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            apikey:
              SUPABASE_ANON_KEY,

            "Content-Type":
              "video/mp4",

            "Content-Length":
              String(stat.size),

            "x-upsert":
              "false"
          },

          body:
            stream,

          duplex:
            "half"
        }
      );

    if (!response.ok) {
      let detail = "";

      try {
        const data =
          await response.json();

        detail =
          data?.message ||
          data?.error ||
          "";
      } catch {}

      throw new Error(
        detail ||
          `Supabase Storage recusou o vídeo (${response.status}).`
      );
    }
  } finally {
    stream.destroy();
  }
}

/* =========================================================
   CAMINHO DO DOWNLOAD
========================================================= */

function storagePathForDownload(
  userId,
  jobId,
  fileName
) {
  return [
    userId,
    jobId,
    safeName(fileName)
  ].join("/");
}

/* =========================================================
   GERA + SALVA DOWNLOAD
========================================================= */

async function createAndStoreDownload(
  job,
  file,
  accessToken
) {
  const dir =
    path.join(
      JOBS,
      job.id
    );

  const output =
    path.join(
      dir,
      `assembled-${String(file.index).padStart(3, "0")}-${crypto.randomUUID()}.mp4`
    );

  const sources = [
    path.join(
      dir,
      `hook-${String(file.hookIndex).padStart(3, "0")}.mp4`
    ),

    path.join(
      dir,
      `body-${String(file.bodyIndex).padStart(3, "0")}.mp4`
    ),

    path.join(
      dir,
      `cta-${String(file.ctaIndex).padStart(3, "0")}.mp4`
    )
  ];

  try {
    await concatNormalized(
      sources,
      output,
      dir
    );

    const storagePath =
      storagePathForDownload(
        job.userId,
        job.id,
        file.name
      );

    await uploadVideoToStorage(
      output,
      storagePath,
      accessToken
    );

    try {
      await registerDownload({
        userId:
          job.userId,

        jobId:
          job.id,

        fileName:
          file.name,

        storagePath,

        originalityScore:
          file.originality,

        accessToken
      });
    } catch (error) {
      await deleteStorageObject(
        storagePath,
        accessToken
      ).catch(() => {});

      throw error;
    }

    return storagePath;
  } finally {
    await fsp.rm(
      output,
      {
        force: true
      }
    );
  }
}

/* =========================================================
   RECUPERA JOB PELOS DOWNLOADS
========================================================= */

function jobFromRows(
  id,
  userId,
  rows
) {
  const files =
    rows
      .filter(
        row =>
          row?.file_name &&
          row?.storage_path
      )
      .map(
        (
          row,
          index
        ) => ({
          name:
            safeName(
              row.file_name
            ),

          index:
            index + 1,

          originality:
            Number.isFinite(
              Number(
                row.originality
              )
            )
              ? Number(
                  row.originality
                )
              : null,

          stored:
            true,

          storagePath:
            row.storage_path,

          hook:
            null,

          body:
            null,

          cta:
            null,

          hookIndex:
            null,

          bodyIndex:
            null,

          ctaIndex:
            null
        })
      );

  if (
    !files.length
  ) {
    return null;
  }

  return {
    id,

    userId,

    status:
      "done",

    total:
      files.length,

    done:
      files.length,

    current:
      "Concluído",

    files,

    error:
      null,

    mode:
      "storage-downloads",

    zip:
      `/api/jobs/${id}/zip`
  };
}

async function getPersistentJob(
  id,
  userId,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&order=file_name.asc`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (
    !response.ok
  ) {
    return null;
  }

  return jobFromRows(
    id,
    userId,
    await response.json()
  );
}

/* =========================================================
   CRIA JOB
========================================================= */

app.post(
  "/api/jobs",

  requireAuth,

  upload.fields([
    {
      name:
        "hooks",

      maxCount:
        MAX_HOOKS
    },

    {
      name:
        "bodies",

      maxCount:
        MAX_BODIES
    },

    {
      name:
        "ctas",

      maxCount:
        MAX_CTAS
    }
  ]),

  async (
    req,
    res
  ) => {
    const storageMode =
      Boolean(
        req.body?.inputs
      );

    let hooks;
    let bodies;
    let ctas;

    try {
      if (
        storageMode
      ) {
        [
          hooks,
          bodies,
          ctas
        ] =
          validateStorageInputs(
            req.body.inputs,
            req.user.id
          );
      } else {
        hooks =
          req.files?.hooks ||
          [];

        bodies =
          req.files?.bodies ||
          [];

        ctas =
          req.files?.ctas ||
          [];
      }
    } catch (error) {
      return res
        .status(400)
        .json({
          error:
            error?.message ||
            "Dados dos vídeos inválidos."
        });
    }

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
      if (
        !storageMode
      ) {
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

      return res
        .status(400)
        .json({
          error:
            `Limite de ${MAX_COMBINATIONS} combinações por lote.`
        });
    }

    let quota;

    try {
      quota =
        await reserveVideoQuota(
          req.user.id,
          req.accessToken,
          total
        );
    } catch (error) {
      if (
        !storageMode
      ) {
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

      return res
        .status(503)
        .json({
          error:
            error?.message ||
            "Não foi possível verificar sua cota mensal."
        });
    }

    if (
      !quota.allowed
    ) {
      if (
        !storageMode
      ) {
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

      return res
        .status(403)
        .json({
          error:
            quota.message ||
            "Limite mensal de vídeos atingido.",

          videosUsed:
            quota.videosUsed,

          monthlyLimit:
            quota.monthlyLimit
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
        recursive:
          true
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

      files:
        [],

      error:
        null,

      mode:
        storageMode
          ? "storage-inputs"
          : "multipart",

      videosUsed:
        quota.videosUsed,

      monthlyLimit:
        quota.monthlyLimit
    };

    jobs.set(
      id,
      job
    );

    res.json({
      id,

      total,

      videosUsed:
        quota.videosUsed,

      monthlyLimit:
        quota.monthlyLimit
    });

    void processJob({
      job,
      dir,
      hooks,
      bodies,
      ctas,
      storageMode,
      accessToken:
        req.accessToken,
      userId:
        req.user.id,
      total
    });
  }
);

/* =========================================================
   PROCESSA JOB
========================================================= */

async function processJob({
  job,
  dir,
  hooks,
  bodies,
  ctas,
  storageMode,
  accessToken,
  userId,
  total
}) {
  const normalizedHooks =
    [];

  const normalizedBodies =
    [];

  const normalizedCtas =
    [];

  let quotaReleased =
    false;

  try {
    /* -----------------------------------------------------
       BAIXA INPUTS DO STORAGE
    ----------------------------------------------------- */

    if (
      storageMode
    ) {
      job.current =
        "Baixando ganchos…";

      for (
        let i = 0;
        i < hooks.length;
        i++
      ) {
        hooks[i].path =
          path.join(
            dir,
            `input-hook-${String(i + 1).padStart(3, "0")}.src`
          );

        await downloadStorageObject(
          hooks[i].storagePath,
          accessToken,
          hooks[i].path
        );
      }

      job.current =
        "Baixando corpos…";

      for (
        let i = 0;
        i < bodies.length;
        i++
      ) {
        bodies[i].path =
          path.join(
            dir,
            `input-body-${String(i + 1).padStart(3, "0")}.src`
          );

        await downloadStorageObject(
          bodies[i].storagePath,
          accessToken,
          bodies[i].path
        );
      }

      job.current =
        "Baixando CTAs…";

      for (
        let i = 0;
        i < ctas.length;
        i++
      ) {
        ctas[i].path =
          path.join(
            dir,
            `input-cta-${String(i + 1).padStart(3, "0")}.src`
          );

        await downloadStorageObject(
          ctas[i].storagePath,
          accessToken,
          ctas[i].path
        );
      }
    }

    /* -----------------------------------------------------
       GANCHOS
    ----------------------------------------------------- */

    job.current =
      "Preparando ganchos…";

    for (
      let i = 0;
      i < hooks.length;
      i++
    ) {
      const output =
        path.join(
          dir,
          `hook-${String(i + 1).padStart(3, "0")}.mp4`
        );

      await normalizeVideo(
        hooks[i].path,
        output,
        dir
      );

      normalizedHooks.push({
        source:
          hooks[i],

        path:
          output
      });

      await fsp.rm(
        hooks[i].path,
        {
          force:
            true
        }
      );
    }

    /* -----------------------------------------------------
       CORPOS
    ----------------------------------------------------- */

    job.current =
      "Preparando corpos…";

    for (
      let i = 0;
      i < bodies.length;
      i++
    ) {
      const output =
        path.join(
          dir,
          `body-${String(i + 1).padStart(3, "0")}.mp4`
        );

      await normalizeVideo(
        bodies[i].path,
        output,
        dir
      );

      normalizedBodies.push({
        source:
          bodies[i],

        path:
          output
      });

      await fsp.rm(
        bodies[i].path,
        {
          force:
            true
        }
      );
    }

    /* -----------------------------------------------------
       CTAs
    ----------------------------------------------------- */

    job.current =
      "Preparando CTAs…";

    for (
      let i = 0;
      i < ctas.length;
      i++
    ) {
      const output =
        path.join(
          dir,
          `cta-${String(i + 1).padStart(3, "0")}.mp4`
        );

      await normalizeVideo(
        ctas[i].path,
        output,
        dir
      );

      normalizedCtas.push({
        source:
          ctas[i],

        path:
          output
      });

      await fsp.rm(
        ctas[i].path,
        {
          force:
            true
        }
      );
    }

    /* -----------------------------------------------------
       COMBINAÇÕES
    ----------------------------------------------------- */

    let index =
      0;

    for (
      let hookIndex = 0;
      hookIndex <
      normalizedHooks.length;
      hookIndex++
    ) {
      for (
        let bodyIndex = 0;
        bodyIndex <
        normalizedBodies.length;
        bodyIndex++
      ) {
        for (
          let ctaIndex = 0;
          ctaIndex <
          normalizedCtas.length;
          ctaIndex++
        ) {
          index++;

          const previousIndex =
            index - 2;

          const current = {
            hook:
              normalizedHooks[
                hookIndex
              ].source.path,

            body:
              normalizedBodies[
                bodyIndex
              ].source.path,

            cta:
              normalizedCtas[
                ctaIndex
              ].source.path
          };

          const previous =
            previousIndex >= 0
              ? {
                  hook:
                    normalizedHooks[
                      Math.floor(
                        previousIndex /
                          (
                            normalizedBodies.length *
                            normalizedCtas.length
                          )
                      )
                    ]?.source.path,

                  body:
                    normalizedBodies[
                      Math.floor(
                        (
                          previousIndex /
                          normalizedCtas.length
                        ) %
                          normalizedBodies.length
                      )
                    ]?.source.path,

                  cta:
                    normalizedCtas[
                      previousIndex %
                        normalizedCtas.length
                    ]?.source.path
                }
              : null;

          job.files.push({
            name:
              `video-${String(index).padStart(3, "0")}.mp4`,

            hook:
              safeName(
                normalizedHooks[
                  hookIndex
                ].source.originalname
              ),

            body:
              safeName(
                normalizedBodies[
                  bodyIndex
                ].source.originalname
              ),

            cta:
              safeName(
                normalizedCtas[
                  ctaIndex
                ].source.originalname
              ),

            hookIndex:
              hookIndex + 1,

            bodyIndex:
              bodyIndex + 1,

            ctaIndex:
              ctaIndex + 1,

            index,

            originality:
              originality(
                current,
                previous
              ),

            stored:
              false,

            storagePath:
              null
          });
        }
      }
    }

    /* -----------------------------------------------------
       GERA VÍDEOS
    ----------------------------------------------------- */

    for (
      let i = 0;
      i < job.files.length;
      i++
    ) {
      job.current =
        `Gerando vídeos: ${i + 1}/${job.files.length}`;

      const file =
        job.files[i];

      file.storagePath =
        await createAndStoreDownload(
          job,
          file,
          accessToken
        );

      file.stored =
        true;

      job.done =
        i + 1;
    }

    /* -----------------------------------------------------
       REMOVE INPUTS DO STORAGE
       SOMENTE DEPOIS DE DAR CERTO
    ----------------------------------------------------- */

    if (
      storageMode
    ) {
      job.current =
        "Limpando vídeos de origem…";

      for (
        const file of [
          ...hooks,
          ...bodies,
          ...ctas
        ]
      ) {
        await deleteStorageObject(
          file.storagePath,
          accessToken
        ).catch(
          error => {
            console.error(
              "GeraMix input cleanup:",
              error
            );
          }
        );
      }
    }

    job.status =
      "done";

    job.current =
      "Concluído";

    job.zip =
      `/api/jobs/${job.id}/zip`;
  } catch (error) {
    console.error(
      "GeraMix processamento:",
      error
    );

    /* -----------------------------------------------------
       REMOVE VÍDEOS JÁ GERADOS
    ----------------------------------------------------- */

    for (
      const file of
        job.files.filter(
          item =>
            item.stored &&
            item.storagePath
        )
    ) {
      await deleteStorageObject(
        file.storagePath,
        accessToken
      ).catch(
        () => {}
      );
    }

    /* -----------------------------------------------------
       REMOVE REGISTROS
    ----------------------------------------------------- */

    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(job.id)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method:
          "DELETE",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    ).catch(
      () => {}
    );

    /* -----------------------------------------------------
       DEVOLVE COTA
    ----------------------------------------------------- */

    if (
      !quotaReleased
    ) {
      quotaReleased =
        true;

      await releaseVideoQuota(
        userId,
        accessToken,
        total
      );
    }

    job.status =
      "error";

    job.current =
      "Falhou";

    job.error =
      error?.message ||
      "Erro desconhecido ao gerar os vídeos.";
  } finally {
    await fsp.rm(
      dir,
      {
        recursive:
          true,

        force:
          true
      }
    ).catch(
      () => {}
    );
  }
}

/* =========================================================
   CONSULTA JOB
========================================================= */

app.get(
  "/api/jobs/:id",
  requireAuth,
  async (
    req,
    res
  ) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (job) {
      if (
        job.userId !==
        req.user.id
      ) {
        return res.sendStatus(
          404
        );
      }

      return res.json(
        job
      );
    }

    const persistent =
      await getPersistentJob(
        req.params.id,
        req.user.id,
        req.accessToken
      );

    if (
      persistent
    ) {
      return res.json(
        persistent
      );
    }

    return res
      .status(404)
      .json({
        error:
          "Processamento não encontrado."
      });
  }
);

/* =========================================================
   ENCONTRA DOWNLOAD
========================================================= */

async function findDownload(
  id,
  userId,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (
    !response.ok
  ) {
    return null;
  }

  const rows =
    await response.json();

  return Array.isArray(rows)
    ? rows[0]
    : null;
}

/* =========================================================
   STREAM VÍDEO DO STORAGE
========================================================= */

async function streamStoredVideo(
  file,
  req,
  res,
  forceDownload = false
) {
  const headers = {
    Authorization:
      `Bearer ${req.accessToken}`,

    apikey:
      SUPABASE_ANON_KEY
  };

  if (
    req.headers.range
  ) {
    headers.Range =
      req.headers.range;
  }

  const response =
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(file.storagePath)}`,
      {
        headers
      }
    );

  if (
    !response.ok
  ) {
    return res.sendStatus(
      response.status === 404
        ? 404
        : 500
    );
  }

  res.status(
    response.status
  );

  res.setHeader(
    "Content-Type",
    response.headers.get(
      "content-type"
    ) ||
      "video/mp4"
  );

  res.setHeader(
    "Accept-Ranges",
    "bytes"
  );

  res.setHeader(
    "Cache-Control",
    "private, no-store"
  );

  res.setHeader(
    "Content-Disposition",
    `${
      forceDownload
        ? "attachment"
        : "inline"
    }; filename="${safeName(
      file.name
    )}"`
  );

  const length =
    response.headers.get(
      "content-length"
    );

  const range =
    response.headers.get(
      "content-range"
    );

  if (
    length
  ) {
    res.setHeader(
      "Content-Length",
      length
    );
  }

  if (
    range
  ) {
    res.setHeader(
      "Content-Range",
      range
    );
  }

  if (
    !response.body
  ) {
    return res.end();
  }

  return Readable
    .fromWeb(
      response.body
    )
    .pipe(
      res
    );
}

/* =========================================================
   VÍDEO DO JOB
========================================================= */

app.get(
  "/api/jobs/:id/video/:name",
  requireAuth,
  async (
    req,
    res
  ) => {
    const job =
      jobs.get(
        req.params.id
      ) ||
      await getPersistentJob(
        req.params.id,
        req.user.id,
        req.accessToken
      );

    if (
      !job ||
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

    const file =
      job.files.find(
        item =>
          item.name ===
          name
      );

    if (
      !file
    ) {
      return res.sendStatus(
        404
      );
    }

    if (
      !file.storagePath
    ) {
      return res
        .status(409)
        .json({
          error:
            "Este vídeo ainda está sendo gerado."
        });
    }

    return streamStoredVideo(
      file,
      req,
      res
    );
  }
);

/* =========================================================
   ZIP
========================================================= */

app.get(
  "/api/jobs/:id/zip",
  requireAuth,
  async (
    req,
    res
  ) => {
    const job =
      jobs.get(
        req.params.id
      ) ||
      await getPersistentJob(
        req.params.id,
        req.user.id,
        req.accessToken
      );

    if (
      !job ||
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
            level:
              0
          }
        }
      );

    archive.on(
      "error",
      error =>
        res.destroy(
          error
        )
    );

    archive.pipe(
      res
    );

    try {
      for (
        const file of
          job.files
      ) {
        if (
          !file.storagePath
        ) {
          throw new Error(
            `O vídeo ${file.name} não está disponível.`
          );
        }

        const response =
          await fetch(
            `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(file.storagePath)}`,
            {
              headers: {
                Authorization:
                  `Bearer ${req.accessToken}`,

                apikey:
                  SUPABASE_ANON_KEY
              }
            }
          );

        if (
          !response.ok ||
          !response.body
        ) {
          throw new Error(
            `Não foi possível ler ${file.name} do Storage.`
          );
        }

        archive.append(
          Readable.fromWeb(
            response.body
          ),
          {
            name:
              file.name
          }
        );
      }

      await archive.finalize();
    } catch (error) {
      console.error(
        "GeraMix ZIP:",
        error
      );

      archive.abort();

      if (
        !res.headersSent
      ) {
        res
          .status(500)
          .send(
            "Erro ao criar ZIP."
          );
      } else {
        res.destroy(
          error
        );
      }
    }
  }
);

/* =========================================================
   LIMPEZA DE EXPIRADOS
========================================================= */

async function cleanupExpiredDownloads(
  userId,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(userId)}&expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (
    !response.ok
  ) {
    return;
  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows)
  ) {
    return;
  }

  for (
    const row of
      rows
  ) {
    if (
      row.storage_path
    ) {
      await deleteStorageObject(
        row.storage_path,
        accessToken
      ).catch(
        () => {}
      );
    }

    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method:
          "DELETE",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    ).catch(
      () => {}
    );
  }
}

/* =========================================================
   CENTRAL DE DOWNLOADS
========================================================= */

app.get(
  "/api/downloads",
  requireAuth,
  async (
    req,
    res
  ) => {
    try {
      await cleanupExpiredDownloads(
        req.user.id,
        req.accessToken
      );

      const response =
        await fetch(
          `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(req.user.id)}&order=created_at.desc`,
          {
            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (
        !response.ok
      ) {
        return res
          .status(500)
          .json({
            error:
              "Não foi possível carregar seus downloads."
          });
      }

      const rows =
        await response.json();

      res.json({
        downloads:
          Array.isArray(
            rows
          )
            ? rows.map(
                row => ({
                  id:
                    row.id,

                  jobId:
                    row.job_id,

                  fileName:
                    row.file_name,

                  originality:
                    Number.isFinite(
                      Number(
                        row.originality
                      )
                    )
                      ? Number(
                          row.originality
                        )
                      : null,

                  createdAt:
                    row.created_at,

                  expiresAt:
                    row.expires_at,

                  videoUrl:
                    `/api/downloads/${encodeURIComponent(row.id)}/video`,

                  downloadUrl:
                    `/api/downloads/${encodeURIComponent(row.id)}/video?download=1`
                })
              )
            : []
      });
    } catch (error) {
      console.error(
        "GeraMix downloads:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Não foi possível carregar seus downloads."
        });
    }
  }
);

/* =========================================================
   ABRIR / BAIXAR DOWNLOAD
========================================================= */

app.get(
  "/api/downloads/:id/video",
  requireAuth,
  async (
    req,
    res
  ) => {
    try {
      const row =
        await findDownload(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (
        !row?.storage_path
      ) {
        return res.sendStatus(
          404
        );
      }

      return streamStoredVideo(
        {
          name:
            row.file_name,

          storagePath:
            row.storage_path
        },

        req,

        res,

        req.query.download ===
          "1"
      );
    } catch (error) {
      console.error(
        "GeraMix download:",
        error
      );

      res.sendStatus(
        500
      );
    }
  }
);

/* =========================================================
   EXCLUI DOWNLOAD
========================================================= */

app.delete(
  "/api/downloads/:id",
  requireAuth,
  async (
    req,
    res
  ) => {
    try {
      const row =
        await findDownload(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (
        !row
      ) {
        return res.sendStatus(
          404
        );
      }

      if (
        row.storage_path
      ) {
        await deleteStorageObject(
          row.storage_path,
          req.accessToken
        );
      }

      const response =
        await fetch(
          `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(req.user.id)}`,
          {
            method:
              "DELETE",

            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (
        !response.ok
      ) {
        return res
          .status(500)
          .json({
            error:
              "Não foi possível excluir o vídeo."
          });
      }

      res.json({
        ok:
          true
      });
    } catch (error) {
      console.error(
        "GeraMix delete download:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Não foi possível excluir o vídeo."
        });
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
      return res
        .status(400)
        .json({
          error:
            `Erro no envio dos vídeos: ${error.message}`
        });
    }

    if (
      error
    ) {
      console.error(
        "GeraMix servidor:",
        error
      );

      return res
        .status(500)
        .json({
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
      `FFmpeg disponível: ${Boolean(
        ffmpegPath
      )}`
    );
  }
);
