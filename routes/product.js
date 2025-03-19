const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
const multer = require('multer');
const { Octokit } = require("@octokit/rest");
const { body, validationResult } = require('express-validator');
require('dotenv').config();

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

const FILE_TYPE_MAP = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg'
};

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // Limit file size to 5MB
});

const createFilePath = (fileName) => `public/uploads/${fileName}`;

const uploadImageToGitHub = async (file, fileName) => {
    try {
        const filePath = createFilePath(fileName);
        const content = file.buffer.toString('base64');
        const { data } = await octokit.repos.createOrUpdateFileContents({
            owner: process.env.GITHUB_REPO.split('/')[0],
            repo: process.env.GITHUB_REPO.split('/')[1],
            path: filePath,
            message: `Upload ${fileName}`,
            content: content,
            branch: process.env.GITHUB_BRANCH
        });
        return data.content.download_url;
    } catch (error) {
        console.error('Error uploading image to GitHub:', error);
        throw new Error('Failed to upload image to GitHub');
    }
};

const processVariants = (variantData) => {
    if (!variantData) return [];
    if (typeof variantData === 'string') {
        try {
            variantData = JSON.parse(variantData);
        } catch (error) {
            console.error('Failed to parse variantData as JSON:', error);
            return [];
        }
    }
    if (!Array.isArray(variantData)) {
        variantData = [variantData];
    }
    return variantData.map(v => ({
        value: v.value ? v.value.trim() : '',
        price: parseFloat(v.price) || 0,
        quantity: parseInt(v.quantity) || 0
    }));
};

// Middleware for client validation
const validateClient = async (req, res, next) => {

    try {
        const token = req.headers.authorization;
        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }
        const tokenValue = token.split(' ')[1];
        jwt.verify(tokenValue, process.env.secret, async (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Forbidden - Invalid token', err });
            }
            if (!user.clientID) {
                return res.status(403).json({ error: 'Forbidden - Invalid token payload' });
            }
            req.clientId = user.clientID; // Attach client ID to request object

            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// Centralized error handling middleware
router.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// POST new product with images
router.post(
    '/',
    upload.array('images', 5),
    [
        body('productName').notEmpty().withMessage('Product name is required'),
        body('price').isFloat({ gt: 0 }).withMessage('Price must be a positive number'),
        body('category').isMongoId().withMessage('Invalid category ID'),
        body('countInStock').isInt({ min: 0 }).withMessage('Count in stock must be a non-negative integer'),
    ],
    validateClient,
    async (req, res) => {
        console.log(req.body);
        console.log(req.clientId);
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const files = req.files;
            if (!files || files.length < 1) return res.status(400).send('No images in the request');

            const category = await Category.findById(req.body.category);
            if (!category) return res.status(400).json({ error: 'Invalid category ID' });

            const imageUploadPromises = files.map(file => {
                if (!FILE_TYPE_MAP[file.mimetype]) {
                    throw new Error('Invalid file type');
                }
                const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
                return uploadImageToGitHub(file, fileName);
            });

            const imagePaths = await Promise.all(imageUploadPromises);
            console.log(imagePaths);
            const newProduct = new Product({
                productName: req.body.productName,
                description: req.body.description,
                richDescription: req.body.richDescription,
                images: imagePaths,
                brand: req.body.brand,
                price: req.body.price,
                category: category,
                countInStock: req.body.countInStock,
                rating: req.body.rating,
                numReviews: req.body.numReviews,
                isFeatured: req.body.isFeatured,
                clientID: req.clientId,
                sizes: processVariants(req.body.sizes),
                colors: processVariants(req.body.colors),
                materials: processVariants(req.body.materials),
                styles: processVariants(req.body.styles),
                titles: processVariants(req.body.titles)
            });
            const savedProduct = await newProduct.save();
            res.json(savedProduct);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
);

// PUT to update an existing product with images
router.put(
    '/:id',
    upload.array('images', 5),
    [
        body('productName').optional().notEmpty().withMessage('Product name is required'),
        body('price').optional().isFloat({ gt: 0 }).withMessage('Price must be a positive number'),
        body('category').optional().isMongoId().withMessage('Invalid category ID'),
        body('countInStock').optional().isInt({ min: 0 }).withMessage('Count in stock must be a non-negative integer'),
    ],
    validateClient,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const files = req.files;
            const category = await Category.findById(req.body.category);
            if (!category) return res.status(400).json({ error: 'Invalid category ID' });

            const product = await Product.findById(req.params.id);
            if (!product) return res.status(404).json({ error: 'Product not found' });

            let updatedImages = product.images;
            if (files.length > 0) {
                const imageUploadPromises = files.map(file => {
                    if (!FILE_TYPE_MAP[file.mimetype]) {
                        throw new Error('Invalid file type');
                    }
                    const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
                    return uploadImageToGitHub(file, fileName);
                });
                const newImagePaths = await Promise.all(imageUploadPromises);
                updatedImages = [...updatedImages, ...newImagePaths];
            }

            const updatedProduct = {
                productName: req.body.productName || product.productName,
                description: req.body.description || product.description,
                richDescription: req.body.richDescription || product.richDescription,
                images: updatedImages,
                brand: req.body.brand || product.brand,
                price: req.body.price || product.price,
                category: category || product.category,
                countInStock: req.body.countInStock || product.countInStock,
                rating: req.body.rating || product.rating,
                numReviews: req.body.numReviews || product.numReviews,
                isFeatured: req.body.isFeatured || product.isFeatured,
                sizes: processVariants(req.body.sizes) || product.sizes,
                colors: processVariants(req.body.colors) || product.colors,
                materials: processVariants(req.body.materials) || product.materials,
                styles: processVariants(req.body.styles) || product.styles,
                titles: processVariants(req.body.titles) || product.titles
            };

            const updatedProductResult = await Product.findByIdAndUpdate(req.params.id, updatedProduct, { new: true });
            res.json(updatedProductResult);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
);

// GET featured products
router.get('/get/featured/:count', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;
        const count = req.params.count ? parseInt(req.params.count, 10) : 0;
        const featuredProducts = await Product.find({ isFeatured: true, clientID: clientId }).limit(count);
        res.json(featuredProducts);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET all products
router.get('/', validateClient, async (req, res) => {

    try {
        const clientId = req.clientId;
        const productList = await Product.find({ clientID: clientId }).populate('category');
        res.json(productList);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET a single product by id
router.get('/:id', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;
        const product = await Product.findOne({ _id: req.params.id, clientID: clientId }).populate('category');
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(product);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE a product by id
router.delete('/:id', validateClient, async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
