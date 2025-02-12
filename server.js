const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const REDCAP_API_URL = process.env.REDCAP_API_URL;
const REDCAP_TOKEN = process.env.REDCAP_TOKEN;
const LAMBDA_SMS_URL = process.env.LAMBDA_SMS_URL;

// Helper: Retry any async operation with exponential backoff
async function retryOperation(operation, maxRetries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            console.error(`Attempt ${attempt} failed: ${error.message}`);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
}

// AWS Lambda SMS function using POST
async function sendSms(participant) {
    // Construct the Lambda URL and append query parameters from the participant object.
    const lambdaUrl = new URL(LAMBDA_SMS_URL);

    // Mandatory parameter
    lambdaUrl.searchParams.append("Phone_Number", participant.phone_number);

    // Optional parameters—append these only if they exist.
    if (participant.name) {
        lambdaUrl.searchParams.append("Name", participant.name);
    }
    if (participant.surname) {
        lambdaUrl.searchParams.append("Surname", participant.surname);
    }
    if (participant.tb_status) {
        lambdaUrl.searchParams.append("TB_Status", participant.tb_status);
    }
    if (participant.language) {
        lambdaUrl.searchParams.append("Language", participant.language);
    }
    if (participant.reminder_time) {
        lambdaUrl.searchParams.append("Reminder_Time", participant.reminder_time);
    }
    if (participant.medication_starting_date) {
        lambdaUrl.searchParams.append("Medication_Starting_Date", participant.medication_starting_date);
    }
    if (participant.reminderOptIn) {
        lambdaUrl.searchParams.append("reminderOptIn", participant.reminderOptIn);
    }
    if (participant.pill_reminders) {
        lambdaUrl.searchParams.append("Pill_Reminders", participant.pill_reminders);
    }
    if (participant.consent) {
        lambdaUrl.searchParams.append("Consent", participant.consent);
    }
    if (participant.passport) {
        lambdaUrl.searchParams.append("Passport", participant.passport);
    }
    if (participant.sa_id) {
        lambdaUrl.searchParams.append("SA_ID", participant.sa_id);
    }

    console.log(`Sending SMS GET request to ${lambdaUrl.toString()}`);
    const response = await axios.get(lambdaUrl.toString());
    console.log("Lambda SMS response:", { status: response.status, data: response.data });

    if (response.status !== 200) {
        throw new Error(`Lambda returned status ${response.status}`);
    }
    return response;
}

// REDCap update function
async function updateRedcapRecord(record) {
    const updatePayload = new URLSearchParams({
        token: REDCAP_TOKEN,
        content: "record",
        action: "import",
        format: "json",
        data: JSON.stringify([{ record_id: record, onboarding_status: "Complete" }])
    });
    const response = await axios.post(REDCAP_API_URL, updatePayload);
    if (response.status !== 200) {
        throw new Error(`Failed to update REDCap with status ${response.status}`);
    }
    return response;
}

app.post("/onboarding_webhook", async (req, res) => {
    try {
        const { record } = req.body;
        if (!record) {
            return res.status(400).json({ status: "error", message: "No record ID received" });
        }
        console.log(`Webhook triggered for record: ${record}`);

        // Step 1: Fetch Participant Data from REDCap
        const fetchPayload = new URLSearchParams({
            token: REDCAP_TOKEN,
            content: "record",
            format: "json",
            type: "flat",
            records: record,
            fields: "record_id,phone_number,randomization_status,onboarding_status"
        });
        const redcapResponse = await axios.post(REDCAP_API_URL, fetchPayload);
        const participant = redcapResponse.data[0];
        if (!participant) {
            console.error("Participant not found for record", record);
            return res.status(404).json({ status: "error", message: "Participant not found" });
        }
        console.log("Participant details:", participant);

        // Only proceed if the participant is eligible
        if (participant.randomization_status !== "Selected" || participant.onboarding_status === "Complete") {
            console.log("Participant not eligible for onboarding");
            return res.status(200).json({ status: "skipped", message: "Participant not eligible for onboarding" });
        }

        // Step 2: Send SMS via AWS Lambda with retries
        await retryOperation(() => sendSms(participant.phone_number), 3, 1000);
        console.log(`SMS sent successfully to ${participant.phone_number}`);

        // Step 3: Update REDCap Record with retries
        await retryOperation(() => updateRedcapRecord(record), 3, 1000);
        console.log(`Updated onboarding status for record ${record}`);

        res.status(200).json({ status: "success", message: "Onboarding completed successfully" });
    } catch (error) {
        console.error("Error:", error.message, error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get("/", (req, res) => res.send("Webhook Running 🚀"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));