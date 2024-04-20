# Purpose

Sends command to open garage door based on result of http get

# Testing

1. Setup / run test install of tag-manger-rails
2. Depending on driver in use:
2a. Setup / run garage-mock-particle-server
2b. Install + start mosquitto (or another mqtt broker)
3. (If using MQTT) publish doorstate to doorstate topic configured
4. use cat and netcat (nc) to pipe test input into authorizer

# Notes

- Pino outputs in JSON, but you can use pino-pretty to format it:
```npm run dev```
- Production run: ```npm start```
- suggest using 'jq' for parsing of output json from production
