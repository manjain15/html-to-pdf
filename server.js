const express = require("express");
const { chromium } = require("playwright");
const { Dropbox } = require("dropbox");
const fetch = require("node-fetch");

const app = express();
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Dropbox setup
const DROPBOX_ACCESS_TOKEN = "sl.u.AGS-5MZbYALn5sdVTHHH2JsaP0fPsj9_tB2WMwzk55kYVKaWrTVfbH2TPqTTgIVjOBtPcP0vCGXnlGxGsk-e_svNfADxBrv6hw-Ok2gRlO9iTKXgfcaSgyK5B73eRBAaOLFI4UF6YR7kNpJYrtzzdmDCD60sVJnqSIv-wv9Z1TZySkq8oVkbpl5X9XK_F0xBpF5yxsHCdObYNTeIn0lOFI3_-OVQR5BZnIlWzfsXKEdmv7Y8IkuZ4xBC8d252HklEzQT3O_tXv2nZYIqgtBkt5_e-O2tw_NYVQzJH0WekTAmVPNHSKToVOtn8cgdfzhM4DxogOiqid8uzyGXTk3sbmFQVMFviQG-WAQqvbVZnOIkraEEXvFDcWD5B2dXfA8QAm5M4gIDs8HHcI9eOT674HiLjX2WA86Q21g7aYJdNQXayAz6nKJYt9qzyLZ8kD3uD-TyWKv_azlqBoaMPFpH1LvbS7_Cejrsoe9o3hAfvT479HMb-0gpWPMY70MLyQg7kVyMnOiAL9Xw3_U6LDWLqNXKSFtZVloByWei31AKE6LVZPbsYtn9dAFZFFy9G2IbLmjmMQFT8zP7BmxQpwzq5hveRXuEHp7sDVxzyfGY-48hKdu9ZzJpEjjmdpkz6bOFnr9wLb0s1c-fe5MO9uCzxE0z1L86Gi52OXL-Tc_KbYd0fa7tMh5mcIQpES2epnZ46a8MKUaDWlcJHprmov4SHoOpKpKsRzTFRyFgB3BqsVzRuvf4xuc5o9u74PaMyuyncVz2EHAZAs-w6NNcnHxd8J7j5OKt4To6zvt7FvUzNuNlk1zD6tZBt9jMb43vHD8DwCSsYBJHIBQGCPvBQMsQmu8z1x2ujJRffEf3VgckYzP1Gp_dWXVWHIvfKETQeKID8GpfsKuoGkAy9LUk8VYfafU5tBETXvHPQpsZUGgWu_DaqXSMEkmKhH_JFBj6PI8i-VEIKtZWXCbR02SAEi9_PHMhYWZK8DZxGFOk6O57ZjcDwFdvFChc5KkXG7GNaH_rhue6kWm4oeOXW4hyPw5aX9nphaKnYCCbNfkSjxVHoPvEFCpZoB_pJz8pfasaVs0nnQNkbIjlwkAbrh1Fm8Dsh1MK0aLHnEHp1nMmHZKW-QiqulrdVwF2MQusEAgldA9SagOJXAWl9JKb9B6Dx9mcIJibH2uT4q6-9Bw5G1ZDqxBUNwUMUmeyq0CqJcL6VxIyNpz6bA-g8v1tSOKv9iffVvzWKp2b_4wce8z3ym7Vz2LMStYDZTbbX1Mb9ecfB3td8dG4R-97zkoxGvT6magELMVO"; // <-- replace this
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
