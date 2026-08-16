const { groq } = require("../config/gemini");
const Recipe = require("../models/Recipe");

// ── POST /api/recipes/analyze ────────────────────────────────
const analyzeImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded" });
    }

    // Convert image to Base64
    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;

    // Call Groq Vision
    const response = await groq.chat.completions.create({
      model: "qwen/qwen3.6-27b",

      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            },
            {
              type: "text",
              text: `Analyze this food image.

Identify all visible food ingredients or food items.

Return ONLY a valid JSON object in exactly this format:
{
  "ingredients": ["ingredient1", "ingredient2", "ingredient3"]
}

Do not include explanations, markdown, or any other text.`,
            },
          ],
        },
      ],

      // Disable Qwen reasoning for this simple vision task
      reasoning_effort: "none",

      // Force valid JSON
      response_format: {
        type: "json_object",
      },

      max_tokens: 500,
    });

    const text = response.choices[0].message.content;

    console.log("Groq response:", text);

    // Parse JSON directly
    const parsed = JSON.parse(text);

    const ingredients = Array.isArray(parsed.ingredients)
      ? parsed.ingredients
      : [];

    res.json({
      ingredients,
      rawResponse: text,
    });
  } catch (error) {
    console.error("Image analysis error:", error);

    res.status(500).json({
      error: "Failed to analyze image",
    });
  }
};

// ── POST /api/recipes/generate ───────────────────────────────
const generateRecipe = async (req, res) => {
  try {
    const { ingredients, dietaryPreference } = req.body;

    if (!ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: "Ingredients are required" });
    }

    // STEP A: Build the dietary filter string
    const dietFilter = dietaryPreference
      ? `The recipe MUST be${dietaryPreference}-friendly.`
      : "";

    // STEP B: Construct the structured JSON prompt
    const prompt = `You are a professional chef and nutritionist. Based on these ingredients:${ingredients.join(", ")}.
${dietFilter}

Generate a detailed recipe in the following JSON format (return ONLY valid JSON, no markdown):
{
  "title": "Recipe Name",
  "ingredients": [{"name": "ingredient name", "quantity": "amount needed"}],
  "instructions": [{"step": 1, "description": "Step description"}],
  "nutrition": {
    "calories": "approximate calories per serving",
    "protein": "protein in grams",
    "carbs": "carbs in grams",
    "fat": "fat in grams",
    "fiber": "fiber in grams"
  },
  "servings": "number of servings",
  "prepTime": "preparation time",
  "cookTime": "cooking time",
  "difficulty": "Easy/Medium/Hard",
  "dietaryTags": ["applicable tags from: vegan, vegetarian, keto, gluten-free, dairy-free, low-carb, high-protein, paleo"],
  "servingSuggestions": ["suggestion 1", "suggestion 2"]
}`;

    // STEP C: Call Groq Text (LLaMA 3.3 70B)
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1500,
    });

    const text = response.choices[0].message.content;

    // STEP D: Extract JSON object from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Failed to parse recipe" });
    }

    const recipe = JSON.parse(jsonMatch[0]);

    // STEP E: Attach the original detected ingredients
    recipe.detectedIngredients = ingredients;

    res.json({ recipe });
  } catch (error) {
    console.error("Recipe generation error:", error);
    res.status(500).json({ error: "Failed to generate recipe" });
  }
};

// ── POST /api/recipes/suggestions ───────────────────────────
const generateMultipleRecipes = async (req, res) => {
  try {
    const { ingredients, dietaryPreference } = req.body;

    if (!ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: "Ingredients are required" });
    }

    const dietFilter = dietaryPreference
      ? `All recipes MUST be${dietaryPreference}-friendly.`
      : "";

    const prompt = `You are a professional chef. Based on these ingredients:${ingredients.join(", ")}.
${dietFilter}

Suggest 3 different recipes that can be made. Return ONLY valid JSON array (no markdown):
[
  {
    "title": "Recipe Name",
    "description": "Brief 1-line description",
    "difficulty": "Easy/Medium/Hard",
    "cookTime": "estimated time",
    "dietaryTags": ["applicable tags"]
  }
]`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });

    const text = response.choices[0].message.content;

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Failed to parse suggestions" });
    }

    const suggestions = JSON.parse(jsonMatch[0]);
    res.json({ suggestions });
  } catch (error) {
    console.error("Multiple recipe error:", error);
    res.status(500).json({ error: "Failed to generate suggestions" });
  }
};

// ── POST /api/recipes/save ───────────────────────────────────
const saveRecipe = async (req, res) => {
  try {
    const recipe = new Recipe(req.body);
    const saved = await recipe.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error("Save recipe error:", error);
    res.status(500).json({ error: "Failed to save recipe" });
  }
};

// ── GET /api/recipes/saved ───────────────────────────────────
const getSavedRecipes = async (req, res) => {
  try {
    const { diet, difficulty, search } = req.query;
    const filter = {};

    if (diet)       filter.dietaryTags  = diet;
    if (difficulty) filter.difficulty   = difficulty;
    if (search)     filter.title        = { $regex: search, $options: "i" };

    const recipes = await Recipe.find(filter).sort({ createdAt: -1 });
    res.json(recipes);
  } catch (error) {
    console.error("Get recipes error:", error);
    res.status(500).json({ error: "Failed to fetch recipes" });
  }
};

// ── GET /api/recipes/saved/:id ───────────────────────────────
const getRecipeById = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }
    res.json(recipe);
  } catch (error) {
    console.error("Get recipe error:", error);
    res.status(500).json({ error: "Failed to fetch recipe" });
  }
};

// ── DELETE /api/recipes/saved/:id ────────────────────────────
const deleteRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findByIdAndDelete(req.params.id);
    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }
    res.json({ message: "Recipe deleted successfully" });
  } catch (error) {
    console.error("Delete recipe error:", error);
    res.status(500).json({ error: "Failed to delete recipe" });
  }
};

module.exports = {
  analyzeImage,
  generateRecipe,
  generateMultipleRecipes,
  saveRecipe,
  getSavedRecipes,
  getRecipeById,
  deleteRecipe,
};
