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

    req.accessToken = token;

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
   RESERVA DE COTA
========================================================= */

async function reserveVideoQuota(
  userId,
  accessToken,
  amount
) {

  const response =
    await fetch(
      SUPABASE_URL +
        "/rest/v1/rpc/reserve_video_quota",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            "Bearer " +
            accessToken,

          apikey:
            SUPABASE_ANON_KEY
        },

        body:
          JSON.stringify({
            p_user_id:
              userId,

            p_amount:
              amount
          })
      }
    );

  if (!response.ok) {

    let details = "";

    try {
      const data =
        await response.json();

      details =
        data?.message ||
        data?.msg ||
        data?.error_description ||
        data?.error ||
        "";
    } catch {
      details = "";
    }

    console.error(
      "GeraMix: erro ao reservar cota.",
      response.status,
      details
    );

    throw new Error(
      "Não foi possível verificar sua cota mensal."
    );
  }

  const data =
    await response.json();

  const result =
    Array.isArray(data)
      ? data[0]
      : data;

  if (!result) {
    throw new Error(
      "O servidor não recebeu a resposta da cota."
    );
  }

  return {
    allowed:
      Boolean(result.allowed),

    videosUsed:
      Number(
        result.videos_used || 0
      ),

    monthlyLimit:
      Number(
        result.monthly_limit || 0
      ),

    message:
      result.message ||
      ""
  };
}

/* =========================================================
   DEVOLVE COTA QUANDO O PROCESSAMENTO FALHA
========================================================= */

async function releaseVideoQuota(
  userId,
  accessToken,
  amount
) {

  if (!amount || amount <= 0) {
    return;
  }

  try {

    const response =
      await fetch(
        SUPABASE_URL +
          "/rest/v1/rpc/release_video_quota",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              "Bearer " +
              accessToken,

            apikey:
              SUPABASE_ANON_KEY
          },

          body:
            JSON.stringify({
              p_user_id:
                userId,

              p_amount:
                amount
            })
        }
      );

    if (!response.ok) {

      let details = "";

      try {
        const data =
          await response.json();

        details =
          data?.message ||
          data?.msg ||
          data?.error_description ||
          data?.error ||
          "";
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: não foi possível devolver a cota.",
        response.status,
        details
      );

      return;
    }

    console.log(
      `GeraMix: ${amount} vídeo(s) devolvido(s) para a cota mensal.`
    );

  } catch (error) {

    console.error(
      "GeraMix: erro ao devolver cota:",
      error
    );
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

  if (!previous)
