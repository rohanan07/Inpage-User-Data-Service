console.log('Container booted, PID:', process.pid);

const express = require('express');
const cors = require('cors');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const app = express();
const PORT = process.env.PORT || 3000;
const TABLE_NAME = process.env.USER_WORDS_TABLE;

// 1. Initialize DynamoDB
// Region is auto-detected from the Fargate Task Metadata
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);

if (!TABLE_NAME) {
  console.warn('⚠️ USER_WORDS_TABLE env var is missing! Writes will fail.');
}

app.use(express.json());
app.use(cors());

// --- 👤 USER IDENTITY MIDDLEWARE ---
// Same middleware as other services to ensure we know WHO is saving data
app.use((req, res, next) => {
  const userId = req.headers['x-user-id'] || 'anonymous';
  const userEmail = req.headers['x-user-email'] || 'unknown';

  req.user = { id: userId, email: userEmail };

  console.log(`[user-data] 👤 Request from User: ${userId} (${req.method} ${req.url})`);
  next();
});
// -----------------------------------

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', service: 'user-data-service' });
});


app.post('/userdata/profile', async (req, res) => {
  const { userLevel } = req.body;
  const userId = req.user.id;

  if (![1,2,3].includes(userLevel)) {
    return res.status(400).json({ error: "userLevel must be 1, 2, or 3" });
  }

  try {
    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId,
        sk: "PROFILE",
        entityType: "PROFILE",
        userLevel,
        updatedAt: Date.now()
      }
    }));

    res.status(200).json({ message: "Profile updated", userLevel });

  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

app.get('/userdata/profile', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :uid AND sk = :sk",
      ExpressionAttributeValues: {
        ":uid": userId,
        ":sk": "PROFILE"
      }
    }));

    const profile = result.Items?.[0];

    res.json({
      userLevel: profile?.userLevel
    });

  } catch (err) {
    console.error("Profile fetch error:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});


// 🔹 POST /userdata/books → Create Book
app.post('/userdata/books', async (req, res) => {
  const { bookId, title } = req.body;
  const userId = req.user.id;

  if (!bookId || !title) {
    return res.status(400).json({ error: "bookId and title required" });
  }

  try {
    const sk = `BOOK#${bookId}`;

    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId,
        sk,
        entityType: "BOOK",
        bookId,
        title,
        createdAt: Date.now()
      }
    }));

    res.status(201).json({ message: "Book created", bookId });

  } catch (err) {
    console.error("Create Book Error:", err);
    res.status(500).json({ error: "Failed to create book" });
  }
});


// 🔹 GET /userdata/books → List Books
app.get('/userdata/books', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :uid AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":uid": userId,
        ":prefix": "BOOK#"
      }
    }));

    res.json({ books: result.Items || [] });

  } catch (err) {
    console.error("List Books Error:", err);
    res.status(500).json({ error: "Failed to fetch books" });
  }
});


// 🔹 POST /userdata/books/:bookId/pages → Create Page
app.post('/userdata/books/:bookId/pages', async (req, res) => {
  const { bookId } = req.params;
  const { pageNumber } = req.body;
  const userId = req.user.id;

  if (!pageNumber) {
    return res.status(400).json({ error: "pageNumber required" });
  }

  try {
    const sk = `BOOK#${bookId}#PAGE#${pageNumber}`;

    await dynamo.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        userId,
        sk,
        entityType: "PAGE",
        bookId,
        pageNumber,
        createdAt: Date.now()
      }
    }));

    res.status(201).json({ message: "Page created", pageNumber });

  } catch (err) {
    console.error("Create Page Error:", err);
    res.status(500).json({ error: "Failed to create page" });
  }
});


// 🔹 GET /userdata/books/:bookId/pages → List Pages
app.get('/userdata/books/:bookId/pages', async (req, res) => {
  const { bookId } = req.params;
  const userId = req.user.id;

  try {
    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :uid AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":uid": userId,
        ":prefix": `BOOK#${bookId}#PAGE#`
      }
    }));

    res.json({ pages: result.Items || [] });

  } catch (err) {
    console.error("List Pages Error:", err);
    res.status(500).json({ error: "Failed to fetch pages" });
  }
});





///////////////////////////////////////////////////////////
// 🔹 POST /userdata/books/:bookId/pages/:pageNumber/words
app.post('/userdata/books/:bookId/pages/:pageNumber/words', async (req, res) => {
  const { bookId, pageNumber } = req.params;
  const { words } = req.body;
  const userId = req.user.id;

  if (!words || !Array.isArray(words)) {
    return res.status(400).json({ error: "words[] required" });
  }

  try {
    const saves = words.map(w => {
      const sk = `BOOK#${bookId}#PAGE#${pageNumber}#WORD#${w.word}`;

      return dynamo.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId,
          sk,
          entityType: "WORD",
          bookId,
          pageNumber,
          word: w.word,
          meaning: w.meaning,
          example: w.example,
          createdAt: Date.now()
        }
      }));
    });

    await Promise.all(saves);

    res.status(201).json({ message: "Words saved" });

  } catch (err) {
    console.error("Save Words Error:", err);
    res.status(500).json({ error: "Failed to save words" });
  }
});


// 🔹 GET /words: Fetch ALL words for the user
app.get('/userdata/words', async (req, res) => {
  const userId = req.user.id;

  if (userId === 'anonymous') {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: {
        ":uid": userId
      }
      // DynamoDB automatically sorts results by the Sort Key (sk)
      // So you get them ordered by Book, then Page, then Word.
    });

    const response = await dynamo.send(command);

    return res.json({
      count: response.Count,
      items: response.Items
    });

  } catch (error) {
    console.error('[user-data] Error fetching words:', error);
    return res.status(500).json({ error: "Failed to fetch user data" });
  }
});

app.listen(PORT, () => {
  console.log(`User Data Service running on port ${PORT}`);
});