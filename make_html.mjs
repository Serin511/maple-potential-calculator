import { readFileSync, writeFileSync, mkdirSync } from "fs";
const js = readFileSync("bundle.js", "utf8");
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>메이플 잠재능력 재설정 장사 계산기</title>
<meta name="description" content="메이플스토리 잠재능력 재설정 장사 수익 계산기 - 공식 확률표 기반, 천장 이월 반영" />
<style>html,body{margin:0;padding:0;background:#12151b}#root{min-height:100vh}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
console.log("dist/index.html:", html.length, "bytes");
