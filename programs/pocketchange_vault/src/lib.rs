use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};

<<<<<<< HEAD
declare_id!("34sgN4q5CaaGCwqePU6d2y6xzBuY5ASA8E8LtXjfyN3c");
=======
declare_id!("FSRUKKMxfWNDiVKKVyxiaaweZR8HZEMnsyHmb8caPjAy");
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

#[program]
pub mod pocketchange_vault {
    use super::*;

    /// Initializes the Vault parameters, sets the admin, and prepares the PCP Mint.
    pub fn initialize(ctx: Context<Initialize>, unstaking_fee_basis_points: u16, profit_share_treasury_bp: u16) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.admin = ctx.accounts.admin.key();
        vault_state.pcp_mint = ctx.accounts.pcp_mint.key();
        vault_state.vault_usdc_account = ctx.accounts.vault_usdc_account.key();
        vault_state.treasury_usdc_account = ctx.accounts.treasury_usdc_account.key();
        vault_state.unstaking_fee_basis_points = unstaking_fee_basis_points; // e.g., 50 = 0.5%
        vault_state.profit_share_treasury_bp = profit_share_treasury_bp; // e.g., 2000 = 20%
        vault_state.total_shares = 0;
        vault_state.total_deposits = 0;
        vault_state.is_borrowing = false;
        vault_state.borrow_amount = 0;
        vault_state.pre_borrow_balance = 0;
        Ok(())
    }

    /// User deposits USDC into the Vault, and receives PCP shares representing their pool percentage.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);

        // Transfer USDC from User to Vault PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_usdc_account.to_account_info(),
            to: ctx.accounts.vault_usdc_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Calculate Shares to Mint (Standard x * total_shares / total_deposits)
        let shares_to_mint = if ctx.accounts.vault_state.total_shares == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(ctx.accounts.vault_state.total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(ctx.accounts.vault_state.total_deposits as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };

        // Mint PCP Shares to the User
        let vault_bump = ctx.bumps.vault_state;
        let seeds = &["vault".as_bytes(), &[vault_bump]];
        let signer = &[&seeds[..]];

        let mint_to_accounts = MintTo {
            mint: ctx.accounts.pcp_mint.to_account_info(),
            to: ctx.accounts.user_pcp_account.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        };
        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_to_accounts,
            signer,
        );
        token::mint_to(mint_to_ctx, shares_to_mint)?;

        // Update Global State
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.total_deposits = vault_state.total_deposits.checked_add(amount).ok_or(VaultError::MathOverflow)?;
        vault_state.total_shares = vault_state.total_shares.checked_add(shares_to_mint).ok_or(VaultError::MathOverflow)?;

        msg!("Deposited {} USDC, Minted {} PCP", amount, shares_to_mint);
        Ok(())
    }

    /// Allows the Admin to withdraw USDC from the vault to perform arbitrage.
    /// This requires atomic transaction composability where the Admin MUST repay
    /// the principal + profit before the end of the transaction.
    pub fn borrow_for_arbitrage(ctx: Context<BorrowForArbitrage>, amount: u64) -> Result<()> {
<<<<<<< HEAD
        let vault_state = &mut ctx.accounts.vault_state;
        require!(ctx.accounts.admin.key() == vault_state.admin, VaultError::Unauthorized);
        require!(!vault_state.is_borrowing, VaultError::BorrowAlreadyActive);

        vault_state.is_borrowing = true;
        vault_state.borrow_amount = amount;
        vault_state.pre_borrow_balance = ctx.accounts.vault_usdc_account.amount;
=======
        let vault_state = &ctx.accounts.vault_state;
        require!(ctx.accounts.admin.key() == vault_state.admin, VaultError::Unauthorized);
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

        let vault_bump = ctx.bumps.vault_state;
        let seeds = &["vault".as_bytes(), &[vault_bump]];
        let signer = &[&seeds[..]];

        let transfer_accounts = Transfer {
            from: ctx.accounts.vault_usdc_account.to_account_info(),
            to: ctx.accounts.admin_usdc_account.to_account_info(),
<<<<<<< HEAD
            authority: vault_state.to_account_info(),
=======
            authority: ctx.accounts.vault_state.to_account_info(),
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, transfer_accounts, signer);
        token::transfer(cpi_ctx, amount)?;

        msg!("Arbitrage Borrow: {} USDC. Must be repaid in same PTB.", amount);
<<<<<<< HEAD
        Ok(())
    }

    /// Process Arbitrage Profit. The admin (Engine) reports the flash loan repayment and profit.
    /// The Engine must have already transferred the principal + total_profit back to the vault prior to calling this.
    /// It calculates the treasury cut, sends it to the treasury, and the remaining profit inflates the pool.
    pub fn process_arbitrage(ctx: Context<ProcessArbitrage>, total_profit: u64) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        require!(ctx.accounts.admin.key() == vault_state.admin, VaultError::Unauthorized);
        require!(vault_state.is_borrowing, VaultError::InsufficientRepayment);
        require!(total_profit > 0, VaultError::ZeroProfit);

        // Calculate treasury share based on profit_share_treasury_bp (e.g., 20% = 2000 bp)
        let treasury_share = (total_profit as u128)
            .checked_mul(vault_state.profit_share_treasury_bp as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(10000)
            .ok_or(VaultError::MathOverflow)? as u64;

        let pool_share = total_profit.checked_sub(treasury_share).ok_or(VaultError::MathOverflow)?;

        // Transfer treasury share from vault to treasury
        if treasury_share > 0 {
            let vault_bump = ctx.bumps.vault_state;
            let seeds = &["vault".as_bytes(), &[vault_bump]];
            let signer = &[&seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.treasury_usdc_account.to_account_info(),
                authority: vault_state.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            token::transfer(cpi_ctx, treasury_share)?;
        }

        // The pool_share remains in the vault. We update total_deposits so the exchange rate of PCP increases.
        vault_state.total_deposits = vault_state.total_deposits.checked_add(pool_share).ok_or(VaultError::MathOverflow)?;

        // Clear borrow state
        vault_state.is_borrowing = false;
        vault_state.borrow_amount = 0;

        msg!("Arbitrage Processed. Profit: {} USDC (Treasury: {}, Pool: {})", total_profit, treasury_share, pool_share);

        Ok(())
    }

=======
        Ok(())
    }

    /// Process Arbitrage Profit. The admin (Engine) reports the flash loan repayment and profit.
    /// The Engine must have already transferred the principal + total_profit back to the vault prior to calling this.
    /// It calculates the treasury cut, sends it to the treasury, and the remaining profit inflates the pool.
    pub fn process_arbitrage(ctx: Context<ProcessArbitrage>, total_profit: u64) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        require!(ctx.accounts.admin.key() == vault_state.admin, VaultError::Unauthorized);
        require!(total_profit > 0, VaultError::ZeroProfit);

        // Calculate treasury share based on profit_share_treasury_bp (e.g., 20% = 2000 bp)
        let treasury_share = (total_profit as u128)
            .checked_mul(vault_state.profit_share_treasury_bp as u128)
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;

        let pool_share = total_profit.checked_sub(treasury_share).unwrap();

        // Transfer treasury share from vault to treasury
        if treasury_share > 0 {
            let vault_bump = ctx.bumps.vault_state;
            let seeds = &["vault".as_bytes(), &[vault_bump]];
            let signer = &[&seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.treasury_usdc_account.to_account_info(),
                authority: vault_state.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            token::transfer(cpi_ctx, treasury_share)?;
        }

        // The pool_share remains in the vault. We update total_deposits so the exchange rate of PCP increases.
        vault_state.total_deposits = vault_state.total_deposits.checked_add(pool_share).unwrap();

        msg!("Arbitrage Processed. Profit: {} USDC (Treasury: {}, Pool: {})", total_profit, treasury_share, pool_share);
        
        Ok(())
    }

>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
    /// User Burns their PCP to withdraw their share of the USDC Pool
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, VaultError::ZeroWithdraw);
        let vault_state = &mut ctx.accounts.vault_state;

        // Calculate User's Underlying USDC balance based on their shares
        let usdc_value = (shares as u128)
            .checked_mul(vault_state.total_deposits as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(vault_state.total_shares as u128)
            .ok_or(VaultError::MathOverflow)? as u64;

        // Calculate unstaking fee (e.g., 50 bp = 0.5%)
        let fee = (usdc_value as u128)
            .checked_mul(vault_state.unstaking_fee_basis_points as u128)
<<<<<<< HEAD
            .ok_or(VaultError::MathOverflow)?
            .checked_div(10000)
            .ok_or(VaultError::MathOverflow)? as u64;

        let usdc_to_return = usdc_value.checked_sub(fee).ok_or(VaultError::MathOverflow)?;
=======
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;

        let usdc_to_return = usdc_value.checked_sub(fee).unwrap();
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

        // Burn User's PCP
        let burn_accounts = Burn {
            mint: ctx.accounts.pcp_mint.to_account_info(),
            from: ctx.accounts.user_pcp_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let burn_ctx = CpiContext::new(cpi_program, burn_accounts);
        token::burn(burn_ctx, shares)?;

        // Transfer USDC to User (net of fee)
        let vault_bump = ctx.bumps.vault_state;
        let seeds = &["vault".as_bytes(), &[vault_bump]];
        let signer = &[&seeds[..]];

        let transfer_accounts = Transfer {
            from: ctx.accounts.vault_usdc_account.to_account_info(),
            to: ctx.accounts.user_usdc_account.to_account_info(),
            authority: vault_state.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer,
        );
        token::transfer(transfer_ctx, usdc_to_return)?;

        // Update state
        // The burned shares are removed from total_shares
<<<<<<< HEAD
        vault_state.total_shares = vault_state.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;

        // total_deposits decreases by `usdc_to_return`. The `fee` stays in the vault,
        // effectively distributed to the remaining pool participants!
        vault_state.total_deposits = vault_state.total_deposits.checked_sub(usdc_to_return).ok_or(VaultError::MathOverflow)?;

        msg!("Withdrew {} USDC (Fee: {} USDC) for {} PCP burned", usdc_to_return, fee, shares);
=======
        vault_state.total_shares = vault_state.total_shares.checked_sub(shares).unwrap();
        
        // total_deposits decreases by `usdc_to_return`. The `fee` stays in the vault, 
        // effectively distributed to the remaining pool participants!
        vault_state.total_deposits = vault_state.total_deposits.checked_sub(usdc_to_return).unwrap();
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

        msg!("Withdrew {} USDC (Fee: {} USDC) for {} PCP burned", usdc_to_return, fee, shares);

        Ok(())
    }
}

// --------------------------------------------------------
// Account Validations
// --------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
<<<<<<< HEAD
        space = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 1 + 8 + 8,
=======
        space = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 8 + 8,
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
        seeds = [b"vault"],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    pub pcp_mint: Account<'info, Mint>,
    pub vault_usdc_account: Account<'info, TokenAccount>,
    pub treasury_usdc_account: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pcp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub user_pcp_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BorrowForArbitrage<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub admin_usdc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProcessArbitrage<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_usdc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"vault"], bump)]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pcp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub user_pcp_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// --------------------------------------------------------
// State & Errors
// --------------------------------------------------------

#[account]
pub struct VaultState {
    pub admin: Pubkey,
    pub pcp_mint: Pubkey,
    pub vault_usdc_account: Pubkey,
    pub treasury_usdc_account: Pubkey,
    pub unstaking_fee_basis_points: u16,
    pub profit_share_treasury_bp: u16,
    pub total_shares: u64,
    pub total_deposits: u64,
    pub is_borrowing: bool,
    pub borrow_amount: u64,
    pub pre_borrow_balance: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDeposit,
    #[msg("Withdraw amount must be greater than zero.")]
    ZeroWithdraw,
    #[msg("Reported profit must be greater than zero.")]
    ZeroProfit,
    #[msg("Unauthorized execution. Only the primary engine node can process arbitrage.")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Borrow already active")]
    BorrowAlreadyActive,
    #[msg("Insufficient repayment")]
    InsufficientRepayment,
}
