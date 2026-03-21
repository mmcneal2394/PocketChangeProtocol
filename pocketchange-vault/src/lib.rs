use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
    system_instruction,
};
use spl_token::instruction as token_instruction;

// PDA Seeds
const VAULT_SEED: &[u8] = b"vault";

// State
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct VaultState {
    pub is_initialized: bool,
    pub admin: Pubkey,
    pub unstake_fee_bps: u16,
    pub treasury_fee_bps: u16,
    pub total_staked_usdc: u64,
}

// Entrypoint
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let discriminator = &instruction_data[0..8];
    let data = &instruction_data[8..];

    match discriminator {
        // [175, 175, 109, 31, 13, 152, 155, 237]
        [175, 175, 109, 31, 13, 152, 155, 237] => process_initialize(program_id, accounts, data),
        
        // [242, 35, 198, 137, 82, 225, 242, 182]
        [242, 35, 198, 137, 82, 225, 242, 182] => process_deposit(program_id, accounts, data),
        
        // [183, 18, 70, 156, 148, 109, 161, 34]
        [183, 18, 70, 156, 148, 109, 161, 34] => process_withdraw(program_id, accounts, data),
        
        // [138, 177, 207, 109, 28, 97, 96, 232]
        [138, 177, 207, 109, 28, 97, 96, 232] => process_borrow(program_id, accounts, data),
        
        // [137, 63, 129, 81, 119, 109, 44, 75]
        [137, 63, 129, 81, 119, 109, 44, 75] => process_arbitrage(program_id, accounts, data),
        
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------------------------------------------------------
// Instructions
// ---------------------------------------------------------

fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("PocketChange: Initialize Vault");
    // Parse fee parameters
    let mut offset = 0;
    
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let unstake_fee_bps = u16::from_le_bytes(data[0..2].try_into().unwrap());
    let treasury_fee_bps = u16::from_le_bytes(data[2..4].try_into().unwrap());

    // Account Iteration
    let account_info_iter = &mut accounts.iter();
    let admin_info = next_account_info(account_info_iter)?;
    let vault_state_info = next_account_info(account_info_iter)?;
    
    // (mock validation logic to skip heavy anchor macros)

    Ok(())
}

fn process_deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("PocketChange: Process Deposit");
    if data.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());

    let account_info_iter = &mut accounts.iter();
    let user_info = next_account_info(account_info_iter)?;
    let vault_state_info = next_account_info(account_info_iter)?;
    let pcp_mint_info = next_account_info(account_info_iter)?;
    let user_usdc_info = next_account_info(account_info_iter)?;
    let vault_usdc_info = next_account_info(account_info_iter)?;
    let user_pcp_info = next_account_info(account_info_iter)?;
    let token_program_info = next_account_info(account_info_iter)?;

    if !user_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // 1. Transfer USDC from User to Vault
    let transfer_ix = token_instruction::transfer(
        token_program_info.key,
        user_usdc_info.key,
        vault_usdc_info.key,
        user_info.key,
        &[],
        amount,
    )?;

    invoke(
        &transfer_ix,
        &[
            user_usdc_info.clone(),
            vault_usdc_info.clone(),
            user_info.clone(),
            token_program_info.clone(),
        ],
    )?;

    // 2. Mint PCP to User
    let (vault_pda, bump) = Pubkey::find_program_address(&[VAULT_SEED], program_id);
    let pda_signer_seeds: &[&[_]] = &[VAULT_SEED, &[bump]];
    
    // Simplified 1:1 math for MVP display
    let mint_amount = amount;

    let mint_ix = token_instruction::mint_to(
        token_program_info.key,
        pcp_mint_info.key,
        user_pcp_info.key,
        &vault_pda,
        &[],
        mint_amount,
    )?;

    invoke_signed(
        &mint_ix,
        &[
            pcp_mint_info.clone(),
            user_pcp_info.clone(),
            vault_state_info.clone(),
            token_program_info.clone(),
        ],
        &[pda_signer_seeds],
    )?;

    Ok(())
}

fn process_withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("PocketChange: Process Withdraw");
    if data.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
    let shares = u64::from_le_bytes(data[0..8].try_into().unwrap());

    let account_info_iter = &mut accounts.iter();
    let user_info = next_account_info(account_info_iter)?;
    let vault_state_info = next_account_info(account_info_iter)?;
    let pcp_mint_info = next_account_info(account_info_iter)?;
    let user_usdc_info = next_account_info(account_info_iter)?;
    let vault_usdc_info = next_account_info(account_info_iter)?;
    let user_pcp_info = next_account_info(account_info_iter)?;
    let token_program_info = next_account_info(account_info_iter)?;

    if !user_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // 1. Burn user PCP shares
    let burn_ix = token_instruction::burn(
        token_program_info.key,
        user_pcp_info.key,
        pcp_mint_info.key,
        user_info.key,
        &[],
        shares,
    )?;

    invoke(
        &burn_ix,
        &[
            user_pcp_info.clone(),
            pcp_mint_info.clone(),
            user_info.clone(),
            token_program_info.clone(),
        ],
    )?;

    // 2. Transfer USDC back to User (subtracting theoretical 0.5% unstake fee)
    let (vault_pda, bump) = Pubkey::find_program_address(&[VAULT_SEED], program_id);
    let pda_signer_seeds: &[&[_]] = &[VAULT_SEED, &[bump]];
    
    let out_amount = shares * 995 / 1000;

    let transfer_ix = token_instruction::transfer(
        token_program_info.key,
        vault_usdc_info.key,
        user_usdc_info.key,
        &vault_pda,
        &[],
        out_amount,
    )?;

    invoke_signed(
        &transfer_ix,
        &[
            vault_usdc_info.clone(),
            user_usdc_info.clone(),
            vault_state_info.clone(), // using vault state as PDA
            token_program_info.clone(),
        ],
        &[pda_signer_seeds],
    )?;

    Ok(())
}

fn process_borrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("PocketChange: Flash Borrow For Engine Process");
    Ok(())
}

fn process_arbitrage(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("PocketChange: Return Flash Borrow + Arbitrage Profit!");
    Ok(())
}
