#!/usr/bin/env python3
"""
PDF to Word conversion script for serverless-converter

This script uses the pdf2docx library to convert PDF files to Word documents.
It's called by the convertPdfToWord.js Lambda function.

Usage: python3 pdf_to_word.py <input_pdf_path> <output_docx_path>
"""

import sys
import os
from pdf2docx import Converter
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')

def convert_pdf_to_word(pdf_path, docx_path):
    """
    Convert PDF to Word document
    
    Args:
        pdf_path (str): Path to input PDF file
        docx_path (str): Path to output Word document
    
    Returns:
        bool: True if conversion was successful, False otherwise
    """
    try:
        # Check if input file exists
        if not os.path.exists(pdf_path):
            logging.error(f"Input file not found: {pdf_path}")
            return False
            
        # Create output directory if it doesn't exist
        output_dir = os.path.dirname(docx_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir)
        
        # Log start of conversion
        logging.info(f"[1/4] Initializing conversion...")
        logging.info(f"Converting {pdf_path} to {docx_path}")
        
        # Get total pages
        cv = Converter(pdf_path)
        total_pages = cv.get_pages()
        logging.info(f"[2/4] Analyzing document structure...")
        logging.info(f"Document has {total_pages} pages")
        
        # Convert PDF to Word
        logging.info(f"[3/4] Converting content...")
        cv.convert(docx_path, start=0, end=None)
        cv.close()
        
        logging.info(f"[4/4] Finalizing document...")
        
        # Check if output file was created
        if os.path.exists(docx_path):
            logging.info(f"Conversion completed successfully: {docx_path}")
            return True
        else:
            logging.error(f"Conversion failed: Output file not created")
            return False
            
    except Exception as e:
        logging.error(f"Conversion error: {str(e)}")
        return False

def main():
    # Check arguments
    if len(sys.argv) != 3:
        logging.error("Usage: python3 pdf_to_word.py <input_pdf_path> <output_docx_path>")
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    docx_path = sys.argv[2]
    
    # Perform conversion
    success = convert_pdf_to_word(pdf_path, docx_path)
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()