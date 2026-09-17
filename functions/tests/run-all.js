// Roda todos os testes desta pasta (test_*.js), um processo por arquivo, e para no primeiro
// que falhar. Feito em Node puro (sem for-loop de shell) porque o "npm test" do Windows usa
// cmd.exe, que não entende sintaxe de bash.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const arquivos = fs.readdirSync(dir).filter((f) => f.startsWith("test_") && f.endsWith(".js")).sort();

let falhou = false;
for (const f of arquivos) {
  console.log(`\n--- ${f} ---`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) falhou = true;
}
process.exit(falhou ? 1 : 0);
