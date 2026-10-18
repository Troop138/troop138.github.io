// App settings. Neither value is a secret: both are visible to anyone who
// opens the page. The Apps Script refuses every request without a valid
// sign-in from someone on the Leaders tab.
window.CLOSET_CONFIG = {
  // Web app URL from Apps Script: Deploy > Manage deployments > Web app URL.
  // Leave empty until it's deployed. Use "demo" to run with sample data.
  apiUrl: "https://script.google.com/macros/s/AKfycbzpBOj_jsxCrMDfsIn_IbS_r0yOxIYDK8VGZObZHrfQ2XqcUJbu4zH2nn-4RCJE6ho/exec",

  // OAuth client ID from Google Cloud console (see README, "Google sign-in").
  googleClientId: "",
};
