const express = require("express");
const { Dropbox } = require("dropbox");
const fetch = require("node-fetch");
const { chromium } = require("playwright");

const app = express();
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.json({ limit: "15mb" }));

// Dropbox setup
const dbx = new Dropbox({
  clientId: process.env.DROPBOX_APP_KEY,
  clientSecret: process.env.DROPBOX_APP_SECRET,
  refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
  fetch
});

// Map report types → Dropbox folders
const folders = {
  property: "/Property Reports",
  suburb: "/Suburb Reports",
  other: "/Other Reports"
};

// Homepage
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Convert HTML → PDF → Dropbox
app.post("/convert", async (req, res) => {
  try {
    const html = req.body.html;
    if (!html) return res.status(400).send("No HTML provided");

    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 10000 });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      displayHeaderFooter: true,
      footerTemplate: `<div style="font-size:10px; width:100%; text-align:center;">
                         Page <span class="pageNumber"></span> of <span class="totalPages"></span>
                       </div>`
    });

    // Determine report type and name
    let reportType = req.body.reportType || "";
    let reportName = req.body.reportName || "";

    if (!reportType || !reportName) {
      const result = await page.evaluate(() => {
        let type = "other";
        let name = "report";

        const metaType = document.querySelector('meta[name="report-type"]');
        if (metaType) type = metaType.getAttribute("content");

        const metaName = document.querySelector('meta[name="report-name"]');
        if (metaName) name = metaName.getAttribute("content");

        const h1 = document.querySelector("h1");
        if (h1) {
          const h1Text = h1.innerText.toLowerCase();
          if (h1Text.includes("property")) type = "property";
          else if (h1Text.includes("suburb")) type = "suburb";
          name = h1.innerText.replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
        }

        return { reportType: type, reportName: name };
      });

      reportType = result.reportType;
      reportName = result.reportName;
    }

    // Sanitize filename
    reportName = reportName.replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
    reportType = reportType.toLowerCase();
    const folderPath = folders[reportType] || folders["other"];
    const filename = `${folderPath}/${reportName}.pdf`;

    await browser.close();

    // Upload to Dropbox
    await dbx.filesUpload({ path: filename, contents: pdf });
    console.log(`✅ PDF uploaded to Dropbox at: ${filename}`);
    res.send(`✅ PDF uploaded to Dropbox at: ${filename}`);

  } catch (err) {
    console.error("❌ Error in /convert:", err);
    res.status(500).send("❌ Internal Server Error - check logs");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("HTML → PDF → Dropbox converter running...");
});
