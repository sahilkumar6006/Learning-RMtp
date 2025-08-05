const express = require('express');
const { check } = require('express-validator');
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post(
  '/register',
  [
    check('username', 'Username is required').not().isEmpty(),
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Please enter a password with 6 or more characters').isLength({ min: 6 })
  ],
  authController.register
);

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post(
  '/login',
  [
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password is required').exists()
  ],
  authController.login
);

// @route   GET /api/auth/me
// @desc    Get current user profile
// @access  Private
router.get('/me', auth.protect, authController.getMe);

// @route   PUT /api/auth/me
// @desc    Update user profile
// @access  Private
router.put(
  '/me',
  [
    auth.protect,
    check('username', 'Username is required').not().isEmpty(),
    check('email', 'Please include a valid email').isEmail()
  ],
  authController.updateProfile
);

// @route   GET /api/auth/logout
// @desc    Logout user / clear cookie
// @access  Private
router.get('/logout', auth.protect, authController.logout);

// @route   POST /api/auth/refresh-token
// @desc    Refresh access token
// @access  Public
router.post('/refresh-token', authController.refreshToken);

// @route   POST /api/auth/forgot-password
// @desc    Forgot password - send reset email
// @access  Public
router.post(
  '/forgot-password',
  check('email', 'Please include a valid email').isEmail(),
  authController.forgotPassword
);

// @route   POST /api/auth/reset-password/:token
// @desc    Reset password
// @access  Public
router.post(
  '/reset-password/:token',
  [
    check('password', 'Please enter a password with 6 or more characters').isLength({ min: 6 }),
    check('confirmPassword', 'Passwords do not match').custom((value, { req }) => value === req.body.password)
  ],
  authController.resetPassword
);

module.exports = router;
