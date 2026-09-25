# SmartCart-Access
SmartCart Access is a secure delivery management system built for the Amazon Developer Hackathon. It integrates Ring's access control APIs with the new Alexa+ MCP standard, allowing small business owners to seamlessly manage and authorize deliveries using secure, AI-driven voice commands.
 
## Track & Challenges
 
- **Primary Track:** Ring (Targeting Access Control & Business Systems)
- **Mini-Challenge 1:** AWS Builder (Utilizing AWS Kiro Crew)
- **Mini-Challenge 2:** Open Source (MIT License)
## How it Works
 
SmartCart Access creates a frictionless, secure loop between the front door, the cloud, and the business owner:
 
1. **Ring Detection:** A delivery driver arrives at the door, triggering an event (motion or doorbell press) via the Ring API.
2. **AWS Kiro Crew Verification:** The self-hosted MCP server catches the webhook and routes the data to AWS Kiro Crew, which cross-references the event with the daily delivery schedule.
3. **Alexa+ Voice Authorization:** If verified, the Alexa+ Agent Skill proactively alerts the business owner: *"A scheduled delivery has arrived. Would you like to unlock the door?"* The owner simply responds, *"Alexa, securely receive the delivery."*
4. **Execution:** The MCP server issues an API command to the Ring smart lock to grant temporary access, monitors the door status, and automatically secures the lock once the delivery is complete.
## Setup Instructions
 
> **Note:** Fill in the exact commands as you build out your project.
 
### Prerequisites
 
- Node.js (v18+)
- A free Ring Developer Account
- AWS Account (Free Tier)
- Alexa+ Agentic Tool web simulator
### Installation
 
1. Clone this repository:
```bash
   git clone https://github.com/YOUR-USERNAME/SmartCart-Access.git
```
2. Install dependencies:
```bash
   npm install
```
3. Create a `.env` file in the root directory and add your keys:
```env
   RING_API_KEY=
   AWS_ACCESS_KEY_ID=
   AWS_SECRET_ACCESS_KEY=
```
4. Start the MCP server (utilizing spec 2025-11-25 and Streamable HTTP):
```bash
   npm run start
```
5. Connect your Alexa+ web simulator to the local MCP server on port 3000.
6. Trigger a simulated event using the Ring Simulator to test the workflow.
## Product Feedback & Friction Logs
 
*We are aiming for the 10% judging bonus! Notes on onboarding, API usage, and tools are logged below.*
 
### Log 1: [Tool/API Name — e.g., Ring API Authentication]
 
- **Task Attempted:**
- **Expected vs. Actual:**
- **Severity Rating (Low/Medium/High/Critical):**
- **Workaround Used:**
- **Actionable Suggestion:**
### Log 2: [Tool/API Name — e.g., MCP Server Setup]
 
- **Task Attempted:**
- **Expected vs. Actual:**
- **Severity Rating (Low/Medium/High/Critical):**
- **Workaround Used:**
- **Actionable Suggestion:**
## License
 
This project is licensed under the MIT License.
