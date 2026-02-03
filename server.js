const express = require("express");
const { chromium } = require("playwright");
const { Dropbox } = require("dropbox");
const fetch = require("node-fetch");

const app = express();
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Dropbox setup
const DROPBOX_ACCESS_TOKEN = "sl.u.AGTlK45x71S2s5zcrtXSxt77SHQGoTEBBrXj0_W_ZumxEkjLQXEMCjUljKZlB8ZPoP7qBpFbF6e4M2CvWuUC76Y-H54kSy4v91Y9NvLhychu1Hlp3FZT2MY8eyIwoJps2T1sKrnZcsPR8ghRiJAuZxD2-Mq-1KLkfy4c3o5UDkDRim0gcwsJyRIZgi0upqS1ByFjLghJIpfrMCyMlwcj7Dmr_cQ-JD4zKjan9VfrQe4rXYi84UBFuCvHpq9FYMIlqgBY4voKj_wPpDVDbvY3DfKKjWeNl5HVGr2MbcnPRPMa2o2PMoRJ6ryC1nuvdDwRglZ2Y6qWzuPgPUkIDM2VL438aA7BuVYFT8Cpw_uo3cn-UefZY6NW9okn-FmvZtCuWM276LEuEJ9tbCLTor4CfNL_g9_WzMO_kV7KqK2eIrgVHiu-BYPy3VmbQGtstdPa6IN7o4xG1ercwP75c3TwptsreTfg1xbqlnkaZN2EwaUS-U8JjPVbP3Od93MFTQ3Zt_O2T5dtlrfFE0gxzTdUCRL2vsDMy5mF0o2Onaytj7n6d7iW_LrFZ8FPLkpK2hxVy7bc6dX4z-UkLav07pOxECTYrbGNroyqnuT0I2TudZDvTC-yfjyKAWG83Wj-bRudRwfaQtiPEBNBUx0tP3OQW-2xVccue2gJqOL2F-QhLvhj-DRRWcHEiCBxnRBAS6ruMA3UOIKy6saXYv1geaLvFUbOJl0gvRJDgyRMi8IuTOUrak2LkH-zRqZP2UWdW9Q4MGWB-YhK7vB0lDW-hHRjIRLhoUer4lEgKESJIiRb-1ekL-J241Ylkgx0I6oWLfre0L5Tl8adGP263UesWcTs611hL8maweJiMA_HA7020yVdCgvDrvZjvirYRK6Hfy8o5PZDiIP3yNYYiWpB_MBjk4S0oJO9NyvYWYLTKro5LEITBN5ZTFmXrOIgNodQWzop9Z-ijlvykhsJymqL7By_4tglMzShrUJUeN_WrUlfTspCR2--C9Zo5-jrALhy-PVx07VGou_EL9UJGBwCGu9jf9FbdTkGtQ1VX4HdaHxodYwgmbZYt8s0egNq_nkDTvG4HUAuenwd6LWnQFRl1aGykxm6mIv8BEJhMqMEwKcdoX0pa61YCsjPMC7HaN7x4fB5ku7YvPi_E9x-Yw6ncarkQIlPxNhKjwhsyf1o3TZQJ8xm-ZvG3zcQfwPeuZ0Wu2bRpWLdq7lgGBUjTxXtBs-XQoWvSGlaDuhE82BqbMF6BRNMqgMAeL0idBdSo3wyahWlOIkNEoSn0lUvXA0omg0v22_5";
const dbx = new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN, fetch });

// Map report types → Dropbox folders
const folders = {
  property: "/Manav Jain/Property Reports",
  suburb: "/Manav Jain/Suburb Reports"
};

// Homepage
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Convert HTML → PDF → Dropbox
app.post("/convert", async (req, res) => {
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

  // Use form fields if provided
  let reportType = req.body.reportType || "";
  let reportName = req.body.reportName || "";

  // If fields not provided, fallback to HTML parsing
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
  const filename = `${folderPath}/${reportName}-${Date.now()}.pdf`;

  await browser.close();

  try {
    await dbx.filesUpload({ path: filename, contents: pdf });
    res.send(`✅ PDF uploaded to Dropbox at: ${filename}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to upload PDF to Dropbox");
  }
});

app.listen(3000, () => {
  console.log("HTML → PDF → Dropbox converter running on http://localhost:3000");
});
