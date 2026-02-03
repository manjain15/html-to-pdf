const express = require("express");
const { chromium } = require("playwright");

const app = express();

// Allow large HTML payloads
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Homepage (UI)
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Convert HTML → PDF
app.post("/convert", async (req, res) => {
  const html = req.body.html;

  if (!html) {
    return res.status(400).send("No HTML provided");
  }

  const browser = await chromium.launch({
    args: ["--no-sandbox"]
  });

  const page = await browser.newPage();

  await page.setContent(html, {
    waitUntil: "networkidle",
    timeout: 10000
  });

  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: {
      top: "20mm",
      bottom: "20mm",
      left: "15mm",
      right: "15mm"
    },
    displayHeaderFooter: true,
    footerTemplate: `
      <div style="font-size:10px; width:100%; text-align:center;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>
    `
  });

  await browser.close();

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": "attachment; filename=report.pdf"
  });

  res.send(pdf);
});

app.listen(3000, () => {
  console.log("HTML → PDF converter running on http://localhost:3000");
});
